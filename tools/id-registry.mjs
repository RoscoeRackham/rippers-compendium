// id-registry.mjs — ids are KEYED, and the key→id map is law.
//
// WHY THIS FILE EXISTS. Until 0.4.11 the generator assigned ids by ROW POSITION
// (`id16('RCcl', ci)` with ci the loop counter). That made snapshot ORDER a silent,
// undocumented invariant of the whole catalogue: when Joiner regenerated
// data/db-snapshot.json from the public views — whose ORDER BY is alphabetical, where the
// old file was in insertion order — 64 of 68 class ids and 343 of 361 skill ids were
// reassigned. `RCcl000000000004` came back naming Arbalist where 0.4.10 shipped Arcanist.
// Nothing errored. Every @UUID link, every `_stats.compendiumSource` on an imported item and
// every Guise binding in an installed world would have quietly resolved to a different class.
//
// So: a key owns its id forever. The registry below is the record of that ownership. Snapshot
// ORDER IS NOW IRRELEVANT — shuffle it and the packs come out byte-identical.
//
// RULES
//  - A key in the registry NEVER changes id. Not to tidy the numbering, not ever.
//  - A genuinely new key gets the next free number for its kind and is written back.
//  - A registered key MISSING from the snapshot fails the build loudly. A class disappearing
//    is a decision somebody made; it must not look like a build.
//
// The registry is committed (data/id-registry.json) rather than re-derived from src/packs,
// so `rm -rf src/packs` cannot resurrect the positional bug by accident.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** kind -> the id prefix the packs already use. */
export const PREFIX = {
  classes: 'RCcl', skills: 'RCsk', heroics: 'RChr', spells: 'RCsp',
  // ✎ 7 Sep 2026 (FIX-journal-id-registry): the player-reference pack had the SAME positional
  // bug the item packs were cured of in 0.4.11, and it bit for the same reason — 0.4.12 added
  // one appendix page (Character Creation) and five SHIPPED journals silently changed identity:
  //   RCje…072 Keystones -> Character Creation, 073 Torments -> Keystones,
  //   074 Personal Vehicle -> Torments, 075 NPC Spells -> Personal Vehicle,
  //   076 Pressure and Stagger -> NPC Spells.
  // Pages moved with them (RCpg…086–090), which is the worse half: a deep link is
  // @UUID[…JournalEntry.<jid>.JournalEntryPage.<pid>], so both halves have to hold still.
  // The journal/page tables were seeded from the ids 0.4.11 actually shipped, read out of
  // commit 6a5b909 — the working tree had already been rebuilt with positional ids by then,
  // so src/packs was not a usable source for the seed.
  journals: 'RCje', pages: 'RCpg',
};

export function id16(prefix, n) {
  const p = prefix.replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
  return (p + String(n).padStart(16 - p.length, '0')).slice(0, 16);
}

/**
 * The key each kind is filed under. Kept here so the seeder and the build cannot disagree.
 *
 * Item kinds are keyed by their database key, which is stamped into the pack's own flags.
 * Journals have no such key — the binder is prose, and a section's identity IS its heading.
 * So a journal is keyed by its NAME and a page by `<journal name>/<page title>`. Both are
 * unique across the pack today and asserted unique by the build, because a duplicate heading
 * would otherwise make two sections fight over one id.
 *
 * The practical consequence, worth stating plainly: RENAMING A HEADING IS RENAMING A KEY.
 * The old key goes missing (the build says so and stops) and the new one mints a fresh id.
 * That is correct — a renamed section is a new thing to a link that pointed at the old one —
 * but it means a rename must be a decision, made in the open, not a typo fix nobody noticed.
 */
export const keyOf = {
  classes: (flags) => flags.classKey,
  skills: (flags) => `${flags.classKey}/${flags.skillKey}`,
  heroics: (flags) => flags.heroicKey,
  spells: (flags) => flags.spellKey,
  journals: (_flags, doc) => doc.name,
  pages: (_flags, doc, page) => `${doc.name}/${page.name}`,
};

export function loadRegistry(moduleRoot) {
  const path = join(moduleRoot, 'data', 'id-registry.json');
  if (!existsSync(path)) throw new Error(`id registry missing at ${path} — run tools/seed-id-registry.mjs once; do NOT let the build invent ids`);
  return { path, data: JSON.parse(readFileSync(path, 'utf8')) };
}

/**
 * Reads an existing key's id, or mints the next free one for a new key.
 * `minted` collects the new keys so the build can report them rather than hide them.
 */
export function makeIdAllocator(registry) {
  const minted = [];
  const used = {};
  for (const kind of Object.keys(PREFIX)) {
    const table = registry.data[kind] ?? (registry.data[kind] = {});
    used[kind] = new Set(Object.values(table));
  }
  const seen = {};
  for (const kind of Object.keys(PREFIX)) seen[kind] = new Set();

  return {
    idFor(kind, key) {
      const table = registry.data[kind];
      if (!table) throw new Error(`unknown id kind "${kind}"`);
      if (!key) throw new Error(`empty key for kind "${kind}" — refusing to allocate an id`);
      seen[kind].add(key);
      const existing = table[key];
      if (existing) return existing;
      let n = Object.keys(table).length + 1;
      let id = id16(PREFIX[kind], n);
      while (used[kind].has(id)) id = id16(PREFIX[kind], ++n);
      table[key] = id;
      used[kind].add(id);
      minted.push({ kind, key, id });
      return id;
    },
    /**
     * Keys the registry knows that this build never asked for.
     * `kinds` is REQUIRED in spirit: two different builds share this registry (the item
     * build and the journal build), and each must police only its own kinds — otherwise the
     * item build would report every journal as missing and refuse to run.
     */
    missing(kinds = Object.keys(PREFIX)) {
      const out = [];
      for (const kind of kinds) {
        for (const key of Object.keys(registry.data[kind] ?? {})) {
          if (!seen[kind].has(key)) out.push({ kind, key, id: registry.data[kind][key] });
        }
      }
      return out;
    },
    minted,
    save() {
      // Stable ordering in the file itself, so a diff of the registry reads as "these keys
      // were added" and never as churn.
      const sorted = {};
      for (const kind of Object.keys(PREFIX)) {
        sorted[kind] = Object.fromEntries(Object.entries(registry.data[kind] ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      }
      writeFileSync(registry.path, JSON.stringify(sorted, null, '\t') + '\n');
    },
  };
}

/** One-time seeding: read the ids already shipped in src/packs and file them by key. */
export function seedFromPacks(moduleRoot) {
  const out = {};
  for (const kind of ['classes', 'skills', 'heroics', 'spells']) {
    out[kind] = {};
    const dir = join(moduleRoot, 'src', 'packs', kind);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const doc = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const flags = doc.flags?.['rippers-compendium'] ?? {};
      const key = keyOf[kind](flags, doc);
      if (!key) throw new Error(`${kind}/${f}: no key in flags — cannot seed the registry from a pack that does not carry its own key`);
      if (out[kind][key]) throw new Error(`${kind}: duplicate key "${key}" (${out[kind][key]} and ${doc._id})`);
      out[kind][key] = doc._id;
    }
  }
  Object.assign(out, seedJournalsFromPacks(moduleRoot));
  return out;
}

/**
 * The journal half of the seed. The player-reference pack is one directory holding both
 * folders and journals, and pages are NESTED inside their journal rather than being files of
 * their own — so it cannot go through the loop above. Folders are skipped deliberately: their
 * three ids are fixed constants in build-journals.mjs, not allocated, and nothing may move
 * them into the registry by accident.
 */
export function seedJournalsFromPacks(moduleRoot) {
  const out = { journals: {}, pages: {} };
  const dir = join(moduleRoot, 'src', 'packs', 'player-reference');
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.startsWith('journal_') && x.endsWith('.json'))) {
    const doc = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const jkey = keyOf.journals(null, doc);
    if (!jkey) throw new Error(`player-reference/${f}: a journal with no name cannot be keyed`);
    if (out.journals[jkey]) throw new Error(`journals: duplicate heading "${jkey}" (${out.journals[jkey]} and ${doc._id})`);
    out.journals[jkey] = doc._id;
    for (const page of doc.pages ?? []) {
      const pkey = keyOf.pages(null, doc, page);
      if (out.pages[pkey]) throw new Error(`pages: duplicate heading "${pkey}" (${out.pages[pkey]} and ${page._id})`);
      out.pages[pkey] = page._id;
    }
  }
  return out;
}
