import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const DIRS = ['apps/desktop/src/renderer', 'apps/web/src', 'apps/store-desktop/src'];
const files = DIRS.flatMap((dir) => fs.readdirSync(path.join(root, dir), { recursive: true })
  .filter((f) => f.endsWith('.css')).map((f) => path.join(dir, f)));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const radii = (css) => [...css.matchAll(/border(?:-(?:top|bottom)-(?:left|right))?-radius:\s*([^;}]+)/g)].map((m) => m[1].trim());
const TOKEN = /^var\(--radius-(xs|sm|row|md|composer|sheet|pill)\)$/;
const PART = (v) => TOKEN.test(v) || ['0', '1px', '2px', 'inherit', '50%'].includes(v);

test('the scale is 8 px surfaces, 6 px controls, 4 px parts', () => {
  const base = read('apps/desktop/src/renderer/tokens.css').match(/:root\s*\{([^}]*)\}/)[1];
  const token = (name) => base.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
  assert.deepEqual(
    ['--radius-xs', '--radius-sm', '--radius-row', '--radius-md', '--radius-composer', '--radius-sheet', '--radius-pill'].map(token),
    ['4px', '6px', '6px', '8px', '8px', '8px', '6px']);
  assert.equal(token('--tint'), 'color-mix(in srgb, var(--text-1) 5%, transparent)');
  assert.equal(token('--tint-strong'), 'color-mix(in srgb, var(--text-1) 9%, transparent)');
  assert.equal(token('--hairline'), 'color-mix(in srgb, var(--text-1) 11%, transparent)');
});

test('no theme block redefines a radius or tint token', () => {
  const css = read('apps/desktop/src/renderer/tokens.css');
  for (const [, block] of css.matchAll(/:root\[data-theme="[a-z]+"\]\s*\{([^}]*)\}/g)) assert.doesNotMatch(block, /--(radius|tint|hairline)/);
});

test('every radius in the renderer is a token, a hairline value or a dot', () => {
  for (const file of files) for (const value of radii(read(file))) {
    assert.ok(value.split(/\s+/).every(PART), `${file}: border-radius: ${value}`);
  }
});

test('circles are limited to dots, spinners and markers', () => {
  // A new circle is a deliberate edit to this table.
  const CIRCLES = { 'apps/desktop/src/renderer/styles.css': 8, 'apps/desktop/src/renderer/usage/usage.css': 3,
    'apps/desktop/src/renderer/space/knowledge.css': 1, 'apps/desktop/src/renderer/workspace.css': 1, 'apps/store-desktop/src/renderer/store.css': 2 };
  const found = Object.fromEntries(files.map((f) => [f, radii(read(f)).filter((v) => v === '50%').length]).filter(([, n]) => n > 0));
  assert.deepEqual(found, CIRCLES);
});
