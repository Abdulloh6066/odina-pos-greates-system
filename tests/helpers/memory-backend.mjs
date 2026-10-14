// Test-only backend harness. No network, credentials, live SDK or filesystem writes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

const clone = value => value == null ? value : structuredClone(value);
export function matches(row, query = {}) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$or') return value.some(q => matches(row, q));
    if (key === '$and') return value.every(q => matches(row, q));
    const actual = row[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.entries(value).every(([op, expected]) => {
        if (op === '$exists') return (actual !== undefined) === expected;
        if (op === '$eq') return JSON.stringify(actual) === JSON.stringify(expected);
        if (op === '$ne') return Array.isArray(actual) ? !actual.includes(expected) : actual !== expected;
        if (op === '$in') return Array.isArray(actual) ? actual.some(v => expected.includes(v)) : expected.includes(actual);
        if (op === '$nin') return Array.isArray(actual) ? actual.every(v => !expected.includes(v)) : !expected.includes(actual);
        if (op === '$gte') return actual >= expected;
        if (op === '$gt') return actual > expected;
        if (op === '$lte') return actual <= expected;
        if (op === '$lt') return actual < expected;
        if (op === '$regex') return new RegExp(expected, value.$options || '').test(String(actual || ''));
        if (op === '$options') return true;
        throw new Error('Unsupported mock operator: ' + op);
      });
    }
    return actual === value;
  });
}
export function memoryBackend(seed = {}, { now = '2026-09-27T07:00:00Z', copySeed = true } = {}) {
  const db = copySeed ? clone(seed) : seed;
  let sequence = 0;
  const calls = [];
  const entities = new Proxy({}, { get(target, name) {
    if (target[name]) return target[name];
    db[name] ??= [];
    const list = (query, sort = 'id', limit = 50, skip = 0) => {
      const desc = sort.startsWith('-'); const field = desc ? sort.slice(1) : sort;
      return clone(db[name].filter(row => matches(row, query)).sort((a, b) => {
        const cmp = String(a[field] ?? '').localeCompare(String(b[field] ?? ''));
        return desc ? -cmp : cmp;
      }).slice(skip, skip + limit));
    };
    const entity = {
      get: async id => clone(db[name].find(row => row.id === id) || null),
      filter: async (query, sort, limit, skip) => list(query, sort, limit, skip),
      list: async (sort, limit, skip) => list({}, sort, limit, skip),
      create: async data => {
        calls.push([name, 'create']);
        const row = { ...clone(data), id: name + '-' + (++sequence), created_date: now, updated_date: now };
        db[name].push(row); return clone(row);
      },
      update: async (id, data) => {
        calls.push([name, 'update']);
        const row = db[name].find(row => row.id === id);
        if (!row) throw new Error('Missing mock record');
        Object.assign(row, clone(data), { updated_date: now }); return clone(row);
      },
      updateMany: async (query, ops) => {
        calls.push([name, 'updateMany']);
        const rows = db[name].filter(row => matches(row, query));
        for (const row of rows) {
          Object.assign(row, clone(ops.$set || {}));
          for (const [field, delta] of Object.entries(ops.$inc || {})) row[field] = Number(row[field] || 0) + Number(delta);
          for (const [field, value] of Object.entries(ops.$push || {})) (row[field] ??= []).push(clone(value));
          for (const [field, value] of Object.entries(ops.$pull || {})) row[field] = (row[field] || []).filter(item => item !== value);
          for (const field of Object.keys(ops.$unset || {})) delete row[field];
        }
        return { success: true, updated: rows.length };
      },
      delete: async id => { calls.push([name, 'delete']); db[name] = db[name].filter(row => row.id !== id); },
    };
    entity.bulkCreate = async rows => Promise.all(rows.map(row => entity.create(row)));
    target[name] = entity; return entity;
  } });
  const service = { entities,
    connectors: { getConnection: async () => ({ accessToken: 'test-only-token' }) },
    integrations: { Core: { SendEmail: async () => { calls.push(['test-email', 'send']); return { success: true }; } } },
  };
  const client = { auth: { me: async () => clone(db.User?.[0] || null) }, asServiceRole: service };
  const RealDate = Date;
  class Clock extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return RealDate.parse(now); }
  }
  const cache = new Map();
  function load(file, extra = {}) {
    const absolute = path.resolve(file);
    if (cache.has(absolute)) return cache.get(absolute);
    const module = { exports: {} }; cache.set(absolute, module.exports);
    const js = ts.transpileModule(readFileSync(absolute, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const context = { crypto: webcrypto, TextEncoder, Response, Request, AbortSignal,
      structuredClone, console, Date: Clock,
      fetch: async () => { throw new Error('NETWORK IS DISABLED IN OFFLINE TESTS'); }, ...extra };
    const requireMock = name => {
      if (name === 'npm:@base44/sdk') return { createClientFromRequest: () => client };
      if (!name.startsWith('.')) throw new Error('Unexpected test dependency: ' + name);
      return load(path.resolve(path.dirname(absolute), name), extra);
    };
    vm.runInNewContext('(function(require,module,exports){' + js + '\n})', context)(requireMock, module, module.exports);
    cache.set(absolute, module.exports); return module.exports;
  }
  async function invoke(file, body, extra) {
    const response = await load(file, extra).default({ json: async () => clone(body) });
    return { status: response.status, data: await response.json() };
  }
  return { db, entities, client, service, calls, load, invoke };
}
