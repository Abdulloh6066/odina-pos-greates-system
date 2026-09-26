// Offline security regression tests. No live Base44 records or external services are used.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import vm from 'node:vm';
import ts from 'typescript';

const read = (path) => readFileSync(path, 'utf8');

test('User RLS allows admin-wide read and self read; only protected owner may update or delete user records directly', () => {
  const schema = JSON.parse(read('base44/entities/User.jsonc'));
  const readRules = schema.rls?.read?.$or || [];
  assert.ok(readRules.some((rule) => rule?.user_condition?.role === 'admin'));
  assert.ok(readRules.some((rule) => rule?.id === '{{user.id}}'));
  assert.equal(schema.properties?.is_owner?.type, "boolean");
  assert.equal(schema.rls?.update?.user_condition?.is_owner, true);
  assert.equal(schema.rls?.delete?.user_condition?.is_owner, true);
  assert.equal(schema.rls?.create, undefined);
});

test('security UI receives sanitized backend status and never reads PIN material', () => {
  const page = read('src/pages/Security.jsx');
  const backend = read('base44/functions/security-admin/entry.ts');
  const config = JSON.parse(read('base44/functions/security-admin/function.jsonc'));

  assert.match(page, /functions\.invoke\(['"]security-admin['"], \{ action: ['"]status['"] \}\)/);
  assert.doesNotMatch(page, /SecuritySettings\.(list|filter|get)/);
  assert.doesNotMatch(page, /pin_hash|pin_salt/);
  assert.match(backend, /pin_set: Boolean/);
  assert.match(backend, /users: \(users \|\| \[\]\)\.map\(safeUser\)/);
  assert.doesNotMatch(backend, /pin_hash:\s*securityRows/);
  assert.equal(config.is_public, false);
});

test('staff access changes use an active stored admin backend and no direct browser User.update', () => {
  const panel = read('src/components/security/StaffAccessPanel.jsx');
  const users = read('src/pages/Users.jsx');
  const backend = read('base44/functions/security-admin/entry.ts');
  const invite = read('base44/functions/staff-invite/entry.ts');
  const inviteConfig = JSON.parse(read('base44/functions/staff-invite/function.jsonc'));

  assert.doesNotMatch(panel, /entities\.User\.update/);
  assert.doesNotMatch(users, /entities\.User\.update/);
  assert.match(panel, /functions\.invoke\(['"]security-admin['"]/);
  assert.match(users, /functions\.invoke\(['"]security-admin['"]/);
  assert.match(backend, /resolveStoredAppUser/);
  assert.match(backend, /userRole\(admin\) !== ["']admin["']/);
  assert.match(backend, /admin\.active === false/);
  assert.match(invite, /resolveStoredAppUser/);
  assert.match(invite, /userRole\(admin\) !== ["']admin["']/);
  assert.equal(inviteConfig.is_public, false);
});

test('staff allowlist check is private, self-only, and enforced after authentication', () => {
  const login = read('src/pages/Login.jsx');
  const register = read('src/pages/Register.jsx');
  const check = read('base44/functions/staff-email-check/entry.ts');
  const config = JSON.parse(read('base44/functions/staff-email-check/function.jsonc'));
  const auth = read('src/lib/AuthContext.jsx');

  // Login/register must not expose an anonymous email-membership oracle.
  for (const page of [login, register]) {
    assert.doesNotMatch(page, /functions\.invoke\(["']staff-email-check["']/);
  }
  assert.equal(config.is_public, false);

  // Backend only verifies the authenticated caller's own account/email.
  assert.match(check, /base44\.auth\.me\(\)/);
  assert.match(check, /service\.entities\.User\.get\(currentUser\.id\)/);
  assert.match(check, /normalizeEmail\(currentUser\.email\)/);
  assert.match(check, /\{ email, status: ["']pending["'] \}/);
  assert.match(check, /STAFF_ROLES\.has\(role\)/);
  assert.doesNotMatch(check, /req\.json\(/);
  assert.doesNotMatch(check, /x-forwarded-for|cf-connecting-ip|ipHits|MAX_CHECKS_PER_WINDOW/);

  // The private self-check is performed only after auth and still fails closed.
  assert.match(auth, /functions\.invoke\(['"]staff-email-check['"], \{\}\)/);
  assert.match(auth, /if \(!access\?\.allowed\)/);
  assert.match(auth, /if \(!APP_ROLES\.has\(hydrated\?\.role\)\)/);
  assert.match(auth, /hydrated\?\.active === false/);
});

test('Telegram birthday callbacks are group-bound, validated, monotonic and audited', () => {
  const webhook = read('base44/functions/telegram-webhook/entry.ts');

  assert.match(webhook, /X-Telegram-Bot-Api-Secret-Token/);
  assert.match(webhook, /cb\.message\?\.chat\?\.id/);
  assert.match(webhook, /TELEGRAM_GROUP_ID/);
  assert.match(webhook, /\^bd:\(\[A-Za-z0-9_-\]\{1,128\}\):\(no\|ok\)\$/);
  assert.match(webhook, /f\.contact_status === ["']aloqa_chiqildi["']/);
  assert.match(webhook, /birthday_contact_updated/);
  assert.match(webhook, /cb\.from\?\.id/);
});

async function pinHash(pin, salt, iterations) {
  const key = await webcrypto.subtle.importKey(
    'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await webcrypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: new TextEncoder().encode(salt),
    iterations,
  }, key, 256);
  return Array.from(new Uint8Array(bits)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function loadPinVerifier() {
  const source = read('base44/functions/complete-sale/entry.ts');
  const start = source.indexOf('const hex =');
  const end = source.indexOf('const IDEMPOTENCY_KEY_PATTERN');
  assert.ok(start >= 0 && end > start);
  const isolated = source.slice(start, end) + '\nglobalThis.verifyOwnerPin = verifyOwnerPin;';
  const code = ts.transpileModule(isolated, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;

  const events = [];
  let sequence = 0;
  const salt = 'offline-security-test-salt';
  const iterations = 100000;
  const hash = await pinHash('246810', salt, iterations);
  const service = {
    entities: {
      SecuritySettings: {
        filter: async () => [{
          key: 'owner_approval_pin',
          pin_hash: hash,
          pin_salt: salt,
          pin_algorithm: 'PBKDF2-SHA256',
          pin_iterations: iterations,
        }],
      },
      ActionHistory: {
        filter: async (query, _sort, limit) => events
          .filter((event) => event.user_id === query.user_id)
          .sort((a, b) => String(b.created_date).localeCompare(String(a.created_date)))
          .slice(0, limit),
        create: async (data) => {
          const row = {
            ...structuredClone(data),
            id: 'event-' + ++sequence,
            created_date: new Date(Date.now() + sequence).toISOString(),
          };
          events.push(row);
          return structuredClone(row);
        },
      },
    },
  };

  const context = vm.createContext({
    crypto: webcrypto,
    TextEncoder,
    Date,
    Response,
    structuredClone,
    console,
  });
  vm.runInContext(code, context);
  return { verify: context.verifyOwnerPin, service, events };
}

test('OWNER PIN accepts the stored hash and blocks an actor after five failures', async () => {
  const { verify, service, events } = await loadPinVerifier();
  const allowedActor = { id: 'allowed', full_name: 'Allowed actor' };
  assert.equal(await verify(service, '246810', allowedActor), true);

  const blockedActor = { id: 'blocked', full_name: 'Blocked actor' };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(await verify(service, '000000', blockedActor), false);
  }
  assert.equal(await verify(service, '246810', blockedActor), false);
  assert.equal(events.filter((event) =>
    event.user_id === 'blocked' && event.action === 'owner_pin_failed'
  ).length, 5);
  assert.equal(events.some((event) =>
    event.user_id === 'blocked' && event.action === 'owner_pin_verified'
  ), false);
});

test('new OWNER PIN requires 6-8 digits while legacy verification remains 4-8 digits', () => {
  const manager = read('src/components/security/PinManager.jsx');
  const setter = read('base44/functions/set-owner-pin/index.ts');
  const sale = read('base44/functions/complete-sale/entry.ts');

  assert.match(manager, /\^\\d\{6,8\}\$/);
  assert.match(setter, /\^\\d\{6,8\}\$/);
  assert.match(sale, /\^\\d\{4,8\}\$/);
  assert.match(sale, /PIN_FAILURE_LIMIT = 5/);
  assert.match(sale, /PIN_FAILURE_WINDOW_MS = 15 \* 60 \* 1000/);
});
