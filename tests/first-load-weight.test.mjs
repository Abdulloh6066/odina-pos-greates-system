// Source-only guards for first-load weight. No SDK, network or business records.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';

test('the embedded Odina mark stays small; the full-size original is served as a file', () => {
  const module = readFileSync('src/components/brand/odina-mark.js', 'utf8');
  assert.match(module, /export default "data:image\/png;base64,[A-Za-z0-9+/=]+";/);
  // The mark is part of the main bundle. The 2047 px original was 295 kB of text here.
  assert.ok(module.length < 40_000, 'embedded logo grew to ' + module.length + ' characters');
  assert.ok(existsSync('public/odina-mark.png'));
  const auth = readFileSync('src/components/AuthLayout.jsx', 'utf8');
  assert.match(auth, /className="odina-auth-watermark" src="\/odina-mark\.png"/);
  assert.doesNotMatch(auth, /brand\/odina-mark/);
});

test('fonts are served by the app itself, with the weights the design uses', () => {
  const index = readFileSync('src/index.css', 'utf8');
  assert.match(index, /^@import '\.\/styles\/fonts\.css';/);
  const fonts = readFileSync('src/styles/fonts.css', 'utf8');
  for (const source of [index, fonts, readFileSync('index.html', 'utf8')]) {
    assert.doesNotMatch(source, /fonts\.(googleapis|gstatic)\.com\/(css|s\/)/);
  }
  const faces = [...fonts.matchAll(/@font-face \{([^}]+)\}/g)].map(([, body]) => ({
    family: body.match(/font-family: '([^']+)'/)[1],
    weight: Number(body.match(/font-weight: (\d+);/)[1]),
    file: body.match(/url\('([^']+)'\)/)[1],
    swap: /font-display: swap;/.test(body),
    ranged: /unicode-range: U\+/.test(body),
  }));
  const weights = family => [...new Set(faces.filter(face => face.family === family).map(face => face.weight))].sort();
  assert.deepEqual(weights('Inter'), [400, 500, 600, 700]);
  assert.deepEqual(weights('Playfair Display'), [500, 600, 700, 800]);
  for (const face of faces) {
    assert.ok(face.swap && face.ranged, face.file);
    assert.ok(existsSync('node_modules/' + face.file), 'missing font file ' + face.file);
  }
});

test('the drag-and-drop reorder dialog is loaded on demand, not with Kassa', () => {
  const pos = readFileSync('src/pages/POS.jsx', 'utf8');
  assert.doesNotMatch(pos, /^import .*ProductOrderDialog/m);
  assert.match(pos, /await import\('@\/components\/pos\/ProductOrderDialog'\)/);
  assert.doesNotMatch(pos, /@hello-pangea\/dnd/);
});
