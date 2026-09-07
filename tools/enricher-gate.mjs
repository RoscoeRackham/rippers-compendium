#!/usr/bin/env node
// enricher-gate.mjs — pre-cut gate: no Foundry automation-enricher token and no editorial-
// register apparatus may ship in a player-facing description or journal page.
// (Coroner AUDIT-048: the old uppercase-only grep couldn't see mixed-case @Embed[.)
//
// Checks, over src/packs/**/*.json:
//  A. ENRICHER tokens  @[A-Za-z]+[...]  in any item `system.description` or journal page text,
//     EXCEPT the legitimate internal class->skill links @UUID[Compendium.rippers-compendium...].
//  B. EDITORIAL-REGISTER apparatus in built JOURNAL pages — the GM-note markers the binder wraps
//     around ✎/⚠ provenance/dev notes so build-journals strips them. Opener/closer:
//        <!--GM-NOTE-->  …  <!--/GM-NOTE-->     (stripped by build-journals.mjs; 0 must survive)
//     Also flags any stray literal ✎ / GM-NOTE marker that survived into a page.
// Exit 0 = clean, 1 = leaks found. Run: node tools/enricher-gate.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PACKS = path.join(MODULE, 'src', 'packs');
const ENRICHER = /@[A-Za-z]+\[[^\]]*\]/g;
const ALLOW = /^@UUID\[Compendium\.rippers-compendium\./; // internal skill/spell links — legit
// Editorial apparatus that must not reach a player page: a surviving GM-NOTE marker (the strip
// failed), OR an unwrapped dev-note tell (a note the binder sweep missed) — pure build/dev
// vocabulary that never belongs in player rules text.
// NB: this deliberately does NOT key on the ✎/⛔ glyphs (god ruling 2026-09-09, superseding the
// 18:01 "0 ✎ in journals" spec): ✎ is OVERLOADED in the binder — 7 Cabinet enchantment table
// rows use it as a house-rename marker ("Briar ✎ (Cursed Armor)"), so a glyph assertion would
// flag legitimate content forever. Explicit GM-NOTE markers + dev-tells only.
const GM_MARKER = /<!--\s*\/?\s*GM-NOTE\s*-->|GM-NOTE|foundryvtt-cli|extractPack|LevelDB|~\/Library|Application Support\/FoundryVTT|\bprojectfu v\d|\.mjs\b|Do not ["“]upgrade/;

const hits = { enricher: [], editorial: [] };
function scanText(where, text) {
  const t = String(text || '');
  for (const m of t.match(ENRICHER) || []) if (!ALLOW.test(m)) hits.enricher.push({ where, token: m });
  if (GM_MARKER.test(t)) hits.editorial.push({ where, sample: (t.match(GM_MARKER) || [''])[0] });
}
for (const pack of fs.readdirSync(PACKS)) {
  const dir = path.join(PACKS, pack);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (d.system?.description) scanText(`${pack}/${d.name}`, d.system.description);
    for (const p of d.pages || []) scanText(`${pack}/${d.name} · ${p.name}`, p.text?.content);
  }
}
const dump = (label, arr) => { console.log(`\n${label}: ${arr.length}`); for (const h of arr) console.log('   ' + JSON.stringify(h)); };
dump('ENRICHER leaks (non-internal)', hits.enricher);
dump('EDITORIAL-register in pages', hits.editorial);
const bad = hits.enricher.length + hits.editorial.length;
console.log(`\n${bad === 0 ? '✓ GATE CLEAN' : '✗ GATE FAIL'} — ${bad} leak(s)`);
process.exit(bad === 0 ? 0 : 1);
