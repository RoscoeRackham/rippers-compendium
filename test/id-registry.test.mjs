// Ids are KEYED, not positional. These tests exist because the alternative shipped once:
// a snapshot regenerated from the public views (alphabetical) instead of insertion order
// reassigned 64/68 class ids and 343/361 skill ids, silently, with no error anywhere.
// The invariant they defend: SNAPSHOT ORDER IS IRRELEVANT TO THE OUTPUT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadRegistry, makeIdAllocator, seedFromPacks, keyOf, id16, PREFIX } from '../tools/id-registry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = join(ROOT, 'data', 'id-registry.json');
const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

test('the registry is exactly the ids the packs ship — no drift in either direction', () => {
  const seeded = seedFromPacks(ROOT);
  for (const kind of Object.keys(PREFIX)) {
    assert.deepEqual(registry[kind], seeded[kind],
      `${kind}: data/id-registry.json disagrees with src/packs. One of them was edited alone.`);
  }
});

test('every id is unique within its kind, and every key owns exactly one', () => {
  for (const kind of Object.keys(PREFIX)) {
    const ids = Object.values(registry[kind]);
    assert.equal(new Set(ids).size, ids.length, `${kind}: duplicate id in the registry`);
    for (const id of ids) assert.match(id, new RegExp(`^${PREFIX[kind]}\\d+$`), `${kind}: ${id} is not a ${PREFIX[kind]} id`);
  }
});

test('a SHUFFLED snapshot allocates byte-identical ids', () => {
  // The exact failure of 0.4.11: same rows, different order.
  const snap = JSON.parse(readFileSync(join(ROOT, 'data', 'db-snapshot.json'), 'utf8'));
  const inOrder = allocate(snap);
  const shuffled = allocate({
    ...snap,
    classes: shuffle(snap.classes),
    class_skills: shuffle(snap.class_skills),
    heroic_skills: shuffle(snap.heroic_skills),
  });
  assert.deepEqual(shuffled, inOrder, 'shuffling the snapshot changed an id — the positional bug is back');
  // and both must equal what is already shipped
  assert.deepEqual(inOrder.classes, registry.classes);
  assert.deepEqual(inOrder.skills, registry.skills);
  assert.deepEqual(inOrder.heroics, registry.heroics);
});

test('a genuinely NEW key takes a fresh id and disturbs nothing', () => {
  const alloc = makeIdAllocator({ path: null, data: structuredClone(registry) });
  const before = alloc.idFor('classes', 'adept');
  const minted = alloc.idFor('classes', 'a_brand_new_class');
  assert.equal(before, registry.classes.adept, 'an existing key moved');
  assert.ok(!Object.values(registry.classes).includes(minted), 'a new key reused a shipped id');
  assert.equal(alloc.minted.length, 1);
  assert.equal(alloc.minted[0].key, 'a_brand_new_class');
  // every previously registered id is still exactly where it was
  for (const [k, v] of Object.entries(registry.classes)) assert.equal(alloc.idFor('classes', k), v, `${k} moved`);
});

test('a registered key missing from the build is reported, not silently dropped', () => {
  const alloc = makeIdAllocator({ path: null, data: structuredClone(registry) });
  for (const k of Object.keys(registry.classes)) if (k !== 'adept') alloc.idFor('classes', k);
  const missing = alloc.missing().filter((m) => m.kind === 'classes');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].key, 'adept');
});

test('an empty key is refused rather than allocated', () => {
  const alloc = makeIdAllocator({ path: null, data: structuredClone(registry) });
  assert.throws(() => alloc.idFor('classes', ''), /empty key/);
  assert.throws(() => alloc.idFor('classes', undefined), /empty key/);
});

test('the build FAILS, non-zero, when a registered key vanishes from the snapshot', () => {
  // Driven for real: a copy of the module with one class removed from the snapshot must not build.
  const work = mkdtempSync(join(tmpdir(), 'idreg-'));
  const mod = join(work, 'm');
  cpSync(ROOT, mod, { recursive: true, filter: (src) => !/node_modules|[\\/]\.git$/.test(src) });
  const snapPath = join(mod, 'data', 'db-snapshot.json');
  const snap = JSON.parse(readFileSync(snapPath, 'utf8'));
  const victim = snap.classes.pop();
  snap.class_skills = snap.class_skills.filter((r) => r.class_key !== victim.key);
  writeFileSync(snapPath, JSON.stringify(snap));
  let failed = false, out = '';
  try {
    execFileSync(process.execPath, [join(mod, 'tools', 'build-compendium.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failed = true;
    out = String(e.stdout ?? '') + String(e.stderr ?? '');
  }
  assert.ok(failed, 'the build succeeded with a class missing — a vanished class must never look like a build');
  assert.match(out, /registered key\(s\) are NOT in this snapshot/);
  assert.match(out, new RegExp(victim.key));
});

function allocate(snap) {
  const alloc = makeIdAllocator({ path: null, data: structuredClone(registry) });
  const out = { classes: {}, skills: {}, heroics: {} };
  for (const r of snap.class_skills) out.skills[`${r.class_key}/${r.skill_key}`] = alloc.idFor('skills', `${r.class_key}/${r.skill_key}`);
  for (const h of snap.heroic_skills) out.heroics[h.key] = alloc.idFor('heroics', h.key);
  for (const c of snap.classes) out.classes[c.key] = alloc.idFor('classes', c.key);
  const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { classes: sortKeys(out.classes), skills: sortKeys(out.skills), heroics: sortKeys(out.heroics) };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

test('id16 pads to 16 characters and keeps the prefix', () => {
  assert.equal(id16('RCcl', 4), 'RCcl000000000004');
  assert.equal(id16('RCcl', 4).length, 16);
  assert.equal(keyOf.skills({ classKey: 'adept', skillKey: 'clarity' }), 'adept/clarity');
});

test('readdirSync sanity: the pack dirs the registry claims actually exist', () => {
  for (const kind of Object.keys(PREFIX)) {
    const n = readdirSync(join(ROOT, 'src', 'packs', kind)).filter((f) => f.endsWith('.json')).length;
    assert.equal(n, Object.keys(registry[kind]).length, `${kind}: ${n} pack files vs ${Object.keys(registry[kind]).length} registry keys`);
  }
});
