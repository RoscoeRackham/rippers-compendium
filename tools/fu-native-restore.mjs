#!/usr/bin/env node
// fu-native-restore.mjs — restore FU-native spell/heroic/skill bodies to clean player text.
// The projectfu install packs store descriptions with Foundry AUTOMATION ENRICHERS, not clean
// prose (Austin FU-sweep, ruled 2026-09-09 "Convert + CRB patch"). This tool:
//   1. matches our FU-native items (by fuid/name) to the extracted projectfu packs;
//   2. MECHANICALLY expands the deterministic enrichers to plain text (lossless):
//        @UUID[..]{label}/@UUID[..id]  -> label / resolved doc name
//        @ICON[..]                     -> dropped (decorative)
//        @EFFECT[status] / @EFFECT[..id]-> status word / resolved effect name
//        @GAIN[N res] / @LOSS[N res]   -> "N HP/MP/IP/Fabula Points/zenit"  (plain integer only)
//        @DMG[N type]                  -> "N type"   (plain integer only)
//        @TYPE[damage all X]           -> "X"
//        @WEAPON[a b c]                -> "a, b, c"
//   3. anything left with an enricher token (formula @GAIN/@LOSS/@DMG with $/@/floor/&step/(),
//      @TYPE[affinity ..], @PROGRESS/@CLOCK clock ops) is a RESIDUAL -> that item needs a CRB
//      prose transcription and is reported, NOT guessed.
// It writes effect_html to data/spells-source.json + data/db-snapshot.json for items fully
// cleaned by conversion, and prints the residual (CRB-needed) list + a provenance ledger.
// Re-runnable. Homebrew items (no FU match) are never touched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.dirname(HERE);
const FUPACKS = process.argv[2] || path.join(process.env.TMPDIR || '/tmp', 'fu-packs');
if (!fs.existsSync(FUPACKS)) { console.error('need extracted fu-packs dir as argv[1]'); process.exit(2); }

const norm = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const RES = { hp: 'HP', mp: 'MP', ip: 'IP', fp: 'Fabula Points', zenit: 'zenit' };

// ---- load FU docs: fuid/name -> doc; id -> name ------------------------------------------
const fu = { fuid: new Map(), name: new Map() };
const idName = new Map();
for (const dir of fs.readdirSync(FUPACKS)) {
  const d = path.join(FUPACKS, dir);
  if (!fs.statSync(d).isDirectory()) continue;
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.json')) continue;
    let doc; try { doc = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { continue; }
    if (doc._id && doc.name) idName.set(doc._id, doc.name);
    if (['skill', 'classFeature', 'heroic', 'spell'].includes(doc.type)) {
      fu.fuid.set(doc.system?.fuid || '', doc);
      fu.name.set(norm(doc.name), doc);
    }
  }
}

// ---- the converter -----------------------------------------------------------------------
const FORMULA = /[$]|floor|ceil|@source|@actor|@target|@item|&step|&sl|\/|\*|:|\+|\(/;
// Render ONLY the deterministic Skill-Level arithmetic ($sl + integers + × + parentheses) to
// the compendium's "(SL × N)" notation. Anything else ($cl, $mbs, $tsc, &sl("..."), &step,
// floor, @actor/@target/@item, division, colons) is NOT deterministic here -> return null so
// the item goes to the CRB-transcription residual instead of being guessed.
function renderExpr(e) {
  const s = String(e).trim();
  if (!/\$sl/.test(s)) return null;
  if (/[&@:/]|floor|ceil|\$(?!sl\b)/.test(s)) return null; // any non-$sl variable/op -> opaque
  return s.replace(/\$sl/g, 'SL').replace(/\*/g, ' × ').replace(/\+/g, ' + ').replace(/\s{2,}/g, ' ').trim();
}
function expand(html) {
  let s = String(html || '');
  // @UUID with label, then without label (resolve id -> name)
  s = s.replace(/@UUID\[[^\]]*\]\{([^}]*)\}/g, (_m, l) => l);
  s = s.replace(/@UUID\[[^\]]*\]/g, (m) => { const i = m.match(/\.([A-Za-z0-9]+)\]$/); return (i && idName.get(i[1])) || (i ? i[1] : m); });
  // other enrichers
  s = s.replace(/@([A-Z]+)\[([^\]]*)\]/g, (m, kind, arg) => {
    const a = arg.replace(/&amp;/g, '&').trim();
    if (kind === 'ICON') return '';
    if (kind === 'EFFECT') {
      if (/Compendium/.test(a)) { const i = a.match(/\.([A-Za-z0-9]+)$/); return (i && idName.get(i[1])) || a; }
      return a; // status word
    }
    if (kind === 'GAIN' || kind === 'LOSS') {
      const mm = a.match(/^(.+?)\s+(hp|mp|ip|fp|zenit)$/i);
      if (mm) {
        const plain = mm[1].match(/^\d+$/);
        if (plain) return `${mm[1]} ${RES[mm[2].toLowerCase()]}`;
        const ex = renderExpr(mm[1]);                       // deterministic $sl arithmetic only
        if (ex) return `(${ex}) ${RES[mm[2].toLowerCase()]}`;
      }
      return m; // opaque formula -> residual for CRB
    }
    if (kind === 'DMG') { const mm = a.match(/^(\d+)\s+([a-z]+)$/i); return mm ? `${mm[1]} ${mm[2]}` : m; }
    if (kind === 'TYPE') { const mm = a.match(/^damage all ([a-z]+)$/i); return mm ? mm[1] : m; }
    if (kind === 'WEAPON') { return /^[a-z ]+$/i.test(a) ? a.split(/\s+/).join(', ') : m; }
    return m; // PROGRESS/CLOCK/anything else -> residual
  });
  // clean any doubled spaces left by dropped @ICON
  return s.replace(/\s{2,}/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
}
const hasEnricher = (s) => /@[A-Z]+\[/.test(String(s || ''));
const fuEffect = (html) => { const p = String(html || '').split(/<hr\s*\/?>/i); return p.length > 1 ? p.slice(1).join('<hr>') : String(html || ''); };

// ---- process spells-source (effectHtml) + db-snapshot (effect_html) -----------------------
const ledger = { converted: [], crbNeeded: [], alreadyClean: [] };
// Spells were renamed (Victorian register) — they match FU only via the trailing "(FUname)" in
// their source string, the same way the earlier restore mapped them.
function fuForSpell(s) {
  let m = fu.fuid.get(s.spell_key) || fu.name.get(norm(s.name));
  if (m) return m;
  const pm = String(s.source || '').match(/\(([^)]+)\)\s*$/);
  if (pm) { const pn = pm[1].split(/,| heroic| ultimate| printed/)[0].trim(); return fu.name.get(norm(pn)); }
  return null;
}
function processItem(name, m, setEffect, isSpell) {
  if (!m) return 'homebrew';
  const raw = isSpell ? String(m.system?.description || '') : fuEffect(m.system?.description); // heroics/skills: drop req block; spells: whole
  const clean = expand(raw);
  if (hasEnricher(clean)) { ledger.crbNeeded.push({ name, type: m.type, residual: (clean.match(/@[A-Z]+\[[^\]]*\]/g) || []) }); return 'crb'; }
  setEffect(clean);
  ledger.converted.push({ name, type: m.type });
  return 'converted';
}

const sp = JSON.parse(fs.readFileSync(path.join(MODULE, 'data', 'spells-source.json'), 'utf8'));
for (const lk of ['class_spells', 'spells']) for (const s of sp[lk] || []) {
  const m = fuForSpell(s);
  if (!m) continue;
  processItem(s.name, m, (v) => { s.effectHtml = v; }, true);
}
const snap = JSON.parse(fs.readFileSync(path.join(MODULE, 'data', 'db-snapshot.json'), 'utf8'));
for (const h of snap.heroic_skills) processItem(h.display_name, fu.fuid.get(h.key) || fu.name.get(norm(h.display_name)), (v) => { h.effect_html = v; }, false);
for (const r of snap.class_skills) processItem(r.display_name, fu.fuid.get(r.skill_key) || fu.name.get(norm(r.display_name)), (v) => { r.effect_html = v; }, false);

if (process.argv.includes('--write')) {
  fs.writeFileSync(path.join(MODULE, 'data', 'spells-source.json'), JSON.stringify(sp, null, 2));
  fs.writeFileSync(path.join(MODULE, 'data', 'db-snapshot.json'), JSON.stringify(snap, null, 2));
  console.log('WROTE spells-source.json + db-snapshot.json');
}
console.log(`converted (mechanical, clean): ${ledger.converted.length}`);
console.log(`CRB-needed (residual formula/clock): ${ledger.crbNeeded.length}`);
for (const c of ledger.crbNeeded) console.log(`   [${c.type}] ${c.name}: ${c.residual.join(' ')}`);
