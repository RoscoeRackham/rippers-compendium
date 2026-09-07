#!/usr/bin/env node
// Regenerates data/db-snapshot.json by reading classes_public, class_skills_public
// and heroic_skills_public with the app's PUBLISHABLE (anon) key — never a service
// key. That is the point: this script is a live proof that 0182_the_shelf_faces_the_street
// actually opened an anonymous read path, the same one rippers-unmasked's public
// /reference route uses. It talks straight to PostgREST over fetch() rather than
// pulling in the @supabase/supabase-js package: PostgREST's REST contract is the
// whole of what supabase-js wraps for a plain select, and a one-shot read tool in a
// module with no other Supabase dependency doesn't need the client library to prove
// the same thing.
//
// Reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from the environment. Point these
// at rippers-unmasked/.env's values (or export them yourself) — they are the public,
// client-side credential; this script has no access to and must never be given a
// service-role key.
//
// Output shape matches the existing data/db-snapshot.json exactly:
//   { generated_from, classes, class_skills, heroic_skills }
// with the same per-row column order the file already uses. classes_public /
// class_skills_public / heroic_skills_public never carry gm_note or provenance
// (excluded by design, per STYLE-skill-copy.md §1) and never carry effect_html
// EITHER — but for a different reason: effect_html is NOT a database column at
// all (confirmed against prod's information_schema, 2026-09-07). It is a
// compendium-layer overlay written directly into data/db-snapshot.json by the
// compendium's own FU-native-enricher commits (0.4.8-candidate: f9b8ddd,
// 70e27c0, 486277e, …) — the DB holds the rule text, the compendium file
// additionally carries a hand/tool-authored Foundry-native HTML rendering of
// it for build-compendium.mjs:482. This file is DB rows + a compendium
// overlay, not a pure DB dump.
//
// OVERLAY RULE: this script fetches the view columns from the DB, then MERGES
// each row's existing effect_html (keyed on class_key+skill_key for
// class_skills, on key for heroic_skills) from the file it is about to
// overwrite, appended last exactly where it already sits on those rows. It is
// never fetched from the DB and never dropped by this script. A row with no
// effect_html in the current file gets none after the merge either — this
// script cannot invent one.

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, '..', 'data', 'db-snapshot.json');

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in the environment.');
  console.error('Export them (see rippers-unmasked/.env) and re-run.');
  process.exit(1);
}

async function selectPublic(view, columns, order) {
  const url = `${SUPABASE_URL}/rest/v1/${view}?select=${encodeURIComponent(columns.join(','))}&order=${encodeURIComponent(order)}`;
  const res = await fetch(url, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`${view}: ${res.status} ${res.statusText} — ${await res.text()}`);
  }
  return res.json();
}

// Column order matches the existing db-snapshot.json rows exactly (effect_html,
// when present, is merged in afterward and always sits last — see reorder()).
const CLASS_COLUMNS = ['key', 'display_name', 'printed_name', 'is_innate_only'];
const CLASS_SKILL_COLUMNS = ['class_key', 'skill_key', 'display_name', 'max_sl', 'summary', 'sort'];
const HEROIC_COLUMNS = ['key', 'display_name', 'summary', 'requirements', 'mastery_classes', 'required_skills', 'creation_banned', 'class_gate'];

function reorder(row, columns) {
  const out = {};
  for (const c of columns) out[c] = row[c];
  if ('effect_html' in row) out.effect_html = row.effect_html;
  return out;
}

function indexBy(rows, keyfn) {
  const map = new Map();
  for (const r of rows) map.set(keyfn(r), r);
  return map;
}

const current = JSON.parse(await readFile(OUT_PATH, 'utf8'));
const currentClassSkillsByKey = indexBy(current.class_skills, (r) => `${r.class_key} ${r.skill_key}`);
const currentHeroicsByKey = indexBy(current.heroic_skills, (r) => r.key);

const [classes, classSkills, heroics] = await Promise.all([
  selectPublic('classes_public', CLASS_COLUMNS, 'key.asc'),
  selectPublic('class_skills_public', CLASS_SKILL_COLUMNS, 'class_key.asc,sort.asc,skill_key.asc'),
  selectPublic('heroic_skills_public', HEROIC_COLUMNS, 'key.asc'),
]);

// Merge the compendium-layer effect_html overlay from the current file onto
// the fresh DB rows before reordering — see the OVERLAY RULE header comment.
for (const r of classSkills) {
  const prior = currentClassSkillsByKey.get(`${r.class_key} ${r.skill_key}`);
  if (prior && 'effect_html' in prior) r.effect_html = prior.effect_html;
}
for (const r of heroics) {
  const prior = currentHeroicsByKey.get(r.key);
  if (prior && 'effect_html' in prior) r.effect_html = prior.effect_html;
}

const snapshot = {
  generated_from: 'Supabase ptvwqdcybmjhchrfrocd public views + compendium overlay (effect_html)',
  classes: classes.map((r) => reorder(r, CLASS_COLUMNS)),
  class_skills: classSkills.map((r) => reorder(r, CLASS_SKILL_COLUMNS)),
  heroic_skills: heroics.map((r) => reorder(r, HEROIC_COLUMNS)),
};

// Sanity check against the file this is about to overwrite, before writing anything.
const firstRowKeysMatch = (a, b, columns) => columns.every((c) => c in a) && columns.every((c) => c in b);
for (const [label, columns, currentArr, nextArr] of [
  ['classes', CLASS_COLUMNS, current.classes, snapshot.classes],
  ['class_skills', CLASS_SKILL_COLUMNS, current.class_skills, snapshot.class_skills],
  ['heroic_skills', HEROIC_COLUMNS, current.heroic_skills, snapshot.heroic_skills],
]) {
  if (!firstRowKeysMatch(currentArr[0], nextArr[0], columns)) {
    console.error(`Shape mismatch on ${label} — refusing to write. Current keys: ${Object.keys(currentArr[0])}. New keys: ${Object.keys(nextArr[0])}.`);
    process.exit(1);
  }
}

await writeFile(OUT_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
console.log(`Wrote ${OUT_PATH}: ${snapshot.classes.length} classes, ${snapshot.class_skills.length} class_skills, ${snapshot.heroic_skills.length} heroic_skills.`);
