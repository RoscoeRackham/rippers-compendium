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
  // Item kinds are one file per document. Journals are not: the player-reference pack is a
  // single directory of journals (plus three folders), and pages live INSIDE their journal.
  for (const kind of ['classes', 'skills', 'heroics', 'spells']) {
    const n = readdirSync(join(ROOT, 'src', 'packs', kind)).filter((f) => f.endsWith('.json')).length;
    assert.equal(n, Object.keys(registry[kind]).length, `${kind}: ${n} pack files vs ${Object.keys(registry[kind]).length} registry keys`);
  }
  const journalFiles = readdirSync(join(ROOT, 'src', 'packs', 'player-reference')).filter((f) => f.startsWith('journal_'));
  assert.equal(journalFiles.length, Object.keys(registry.journals).length,
    `journals: ${journalFiles.length} pack files vs ${Object.keys(registry.journals).length} registry keys`);
});

// ---------------------------------------------------------------------------------------
// FIX-journal-id-registry (0.4.12). The journal pack had the SAME positional bug the item
// packs were cured of in 0.4.11, and it bit the same way: 0.4.12 inserted ONE appendix page
// and five ALREADY-SHIPPED journals changed identity underneath every link pointing at them.
// These are the ids 0.4.11 actually shipped, read out of that release. They are law.
// ---------------------------------------------------------------------------------------
const SHIPPED_0_4_11 = {
  // the five that moved, and the three before them — the whole appendix tail
  Heroics: 'RCje000000000069',
  'Arcana Registry': 'RCje000000000070',
  Arcanum: 'RCje000000000071',
  Keystones: 'RCje000000000072',
  Torments: 'RCje000000000073',
  'Personal Vehicle': 'RCje000000000074',
  'NPC Spells': 'RCje000000000075',
  'Pressure and Stagger': 'RCje000000000076',
};

test('0.4.11 journal ids are law: every shipped heading still owns the id it shipped with', () => {
  for (const [heading, id] of Object.entries(SHIPPED_0_4_11)) {
    assert.equal(registry.journals[heading], id,
      `"${heading}" moved from ${id} to ${registry.journals[heading]} — a shipped id may never change`);
  }
});

test('the shipped ids are what the PACK carries, not merely what the registry claims', () => {
  // The registry and the pack can only disagree if one was edited alone; assert against the
  // built artifact so this test cannot pass on a stale or hand-edited registry.
  const dir = join(ROOT, 'src', 'packs', 'player-reference');
  const byId = {};
  for (const f of readdirSync(dir).filter((x) => x.startsWith('journal_'))) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    byId[d._id] = d.name;
  }
  for (const [heading, id] of Object.entries(SHIPPED_0_4_11)) {
    assert.equal(byId[id], heading, `pack: ${id} names "${byId[id]}", but 0.4.11 shipped it as "${heading}"`);
  }
});

test('Character Creation — new in 0.4.12 — minted a FRESH id and displaced nobody', () => {
  const id = registry.journals['Character Creation'];
  assert.ok(id, 'Character Creation is not in the registry');
  assert.ok(!Object.values(SHIPPED_0_4_11).includes(id), `Character Creation took ${id}, a 0.4.11 id`);
  assert.equal(id, 'RCje000000000077', 'the next free journal id after 0.4.11 is 077');
});

test('a NEW heading takes a new id and moves no journal or page', () => {
  const alloc = makeIdAllocator({ path: null, data: structuredClone(registry) });
  const minted = alloc.idFor('journals', 'A Heading That Has Never Existed');
  assert.ok(!Object.values(registry.journals).includes(minted), 'a new heading reused a shipped id');
  for (const [k, v] of Object.entries(registry.journals)) assert.equal(alloc.idFor('journals', k), v, `journal "${k}" moved`);
  for (const [k, v] of Object.entries(registry.pages)) assert.equal(alloc.idFor('pages', k), v, `page "${k}" moved`);
});

test('page ids are keyed too — the half a deep @UUID link resolves through', () => {
  // @UUID[...JournalEntry.<jid>.JournalEntryPage.<pid>] needs BOTH halves to hold still, so
  // fixing journals alone would have left every deep link broken in exactly the same way.
  for (const [heading, jid] of Object.entries(SHIPPED_0_4_11)) {
    const pid = registry.pages[`${heading}/${heading}`];
    assert.ok(pid, `no page id registered for "${heading}"`);
    assert.match(pid, /^RCpg\d+$/);
    assert.ok(jid);
  }
  assert.equal(registry.pages['Keystones/Keystones'], 'RCpg000000000086', 'the Keystones page moved');
  assert.equal(registry.pages['Pressure and Stagger/Pressure and Stagger'], 'RCpg000000000090');
});

test('a renamed heading is reported as missing rather than quietly re-minted', () => {
  const alloc = makeIdAllocator({ path: null, data: structuredClone(registry) });
  for (const k of Object.keys(registry.journals)) if (k !== 'Torments') alloc.idFor('journals', k);
  for (const k of Object.keys(registry.pages)) alloc.idFor('pages', k);
  const missing = alloc.missing(['journals']).filter((m) => m.kind === 'journals');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].key, 'Torments');
  assert.equal(missing[0].id, 'RCje000000000073');
});

test('missing() is scoped per kind, so the item build never polices journals', () => {
  const alloc = makeIdAllocator({ path: null, data: structuredClone(registry) });
  for (const k of Object.keys(registry.classes)) alloc.idFor('classes', k);
  // The item build asks about its four kinds only; journals must not surface here.
  assert.deepEqual(alloc.missing(['classes']), []);
  assert.ok(alloc.missing(['journals']).length > 0, 'journals should be unseen by an item-only build');
});
