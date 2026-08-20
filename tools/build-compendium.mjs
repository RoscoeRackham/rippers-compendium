// build-compendium.mjs — generate the rippers-compendium pack sources.
// Emits three Foundry Item packs the GM drags onto Project FU sheets:
//   src/packs/classes/*.json   — one type:"class"  Item per Rippers class (51)
//   src/packs/skills/*.json    — one type:"skill"  Item per class skill (UUID-linked
//                                from each class description)
//   src/packs/heroics/*.json   — one type:"heroic" Item per heroic skill, WITH its
//                                requirement listed (T77 fix: reqs synthesised from the
//                                structured cols where the requirements text is blank)
//
// SOURCES (dev-tree tool, like build-class-compendium.mjs / build-spells.mjs):
//   data/db-snapshot.json      — a committed snapshot of the maintained class registry
//                                (public.classes / class_skills / heroic_skills), the
//                                same rows the app serves. Re-snapshot from Supabase to refresh.
//   ../../lodge-docs/CLASSREF-*.md — the maintained class cards (identity/also-names +
//                                the "Free Benefits" row). Read for alt-names and any
//                                CONCRETE free benefit; never for design prose.
//
// PLAYER-SAFE: the registry prose carries the house ✎/⚠/⛔ commentary-leak glyphs (T38).
// strip() ports the shipped policy (src/lib/stripCommentary.ts / build-class-compendium.mjs):
// remove glyph-led balanced parentheticals, drop glyph-led sentences, tidy residuals.
//
// BENEFITS (Austin ruling 2026-08-20 — TRUE-with-note): activate a class's FU benefit
// flags and record a one-line house note. BUT the maintained cards deliberately zeroed
// per-class benefits ("Free Benefits — dead letters; the audit does not record what the
// printed ones were"), so only benefits the card states CONCRETELY are set true; every
// class with no recorded benefit is FLAGGED (never guessed) for Austin's per-class list.
//
// Run:  node tools/build-compendium.mjs   (from the module dir)
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = dirname(HERE);
const DOCS = join(MODULE, '..', '..', 'lodge-docs');
const SNAP = join(MODULE, 'data', 'db-snapshot.json');
const MODULE_ID = 'rippers-compendium';

// ---- guise-eligible set (from CLASSREF-index.md, via build-class-compendium.mjs) -------
const GUISE = new Set(['adept','antiquarian','apothecary','batman','bounty-hunter','captain',
  'cartomancer','celebrity','chanter','confidence-man','cook','courier','cunning-folk',
  'dancer','dowser','fencer','floralist','illusionist','magistrate','malefactor',
  'naturalist','parasite','penny-knight','physician','reaper','sensitive','sin-eater',
  'slayer','stalwart','symbolist','witness']);

// ---- strip policy (ported from src/lib/stripCommentary.ts) ------------------------------
const GLYPH = '✎⚠⛔✅';
const GLYPH_RE = new RegExp(`[${GLYPH}]`, 'u');
const GLYPH_G = new RegExp(`[${GLYPH}]`, 'gu');
const RESTATE = /^\*\*[A-Z0-9][A-Z0-9 ·×()'’.\/-]*\*\*\s+—\s+\S/;
function stripGlyphParentheticals(text) {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (GLYPH.includes(ch)) {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '(') {
        let depth = 0, k = j;
        for (; k < text.length; k++) {
          if (text[k] === '(') depth++;
          else if (text[k] === ')') { depth--; if (depth === 0) { k++; break; } }
        }
        i = k; continue;
      }
    }
    out += ch; i += 1;
  }
  return out;
}
function splitSentences(text) {
  const parts = text.match(/[^.!?]*[.!?]+(?:["'”’)\]]*)?|\S[^.!?]*$/g);
  return parts ?? [text];
}
const isGlyphLed = (s) => { const t = s.trimStart(); return t.length > 0 && GLYPH.includes(t[0]); };
function tidy(text) {
  return text
    .replace(GLYPH_G, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/([([]) +/g, '$1')
    .replace(/^[\s—–-]+/, '')
    .replace(/[\s—–,;:]+$/, (m) => (/[.!?]/.test(m) ? m : ''))
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function strip(text) {
  if (!text) return '';
  if (!GLYPH_RE.test(text)) return text;
  const deParen = stripGlyphParentheticals(text);
  const kept = splitSentences(deParen)
    .filter((s) => !isGlyphLed(s) || RESTATE.test(s.replace(GLYPH_G, '').trimStart()))
    .join(' ');
  return tidy(kept);
}

// ---- helpers ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function id16(prefix, n) {
  const p = prefix.replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
  return (p + String(n).padStart(16 - p.length, '0')).slice(0, 16);
}
const titleCase = (s) => String(s || '').replace(/-/g, ' ').replace(/\b([a-z])/g, (m) => m.toUpperCase());

// DB keys use underscores (bounty_hunter); the CLASSREF files use hyphens.
const cardKey = (key) => String(key).replace(/_/g, '-');

// Pull the "also **A · B · C**" alt-names from a class card's subtitle line.
function alsoNames(key) {
  const f = join(DOCS, `CLASSREF-${cardKey(key)}.md`);
  if (!existsSync(f)) return null;
  const head = readFileSync(f, 'utf8').split('\n').slice(0, 6).join('\n');
  const m = head.match(/also\s+\*\*(.+?)\*\*/i);
  if (!m) return null;
  return m[1].replace(/\s*·\s*/g, ', ').replace(/\s{2,}/g, ' ').trim();
}

// Scan a class card's "Free Benefits" row for CONCRETE printed benefits. The
// maintained cards record the printed FU benefits (marked inert under the old
// no-innate rule); the 2026-08-20 ruling reactivates them, so we read them back.
// Returns { resources, martials, rituals, choiceHpMp, parts[] } or null if the
// row states no benefit. "HP or MP, your choice" cannot be a fixed boolean —
// we leave both false and record it as a player choice (choiceHpMp).
const RITUAL_KINDS = ['arcanism', 'chimerism', 'elementalism', 'entropism', 'ritualism', 'spiritism'];
function concreteBenefits(key) {
  const f = join(DOCS, `CLASSREF-${cardKey(key)}.md`);
  if (!existsSync(f)) return null;
  const text = readFileSync(f, 'utf8');
  const rowRaw = text.split('\n').find((l) => /free\s*benefit/i.test(l) && /\|/.test(l));
  if (!rowRaw) return null;
  // isolate the benefit cell (second column) and normalise for matching
  const cell = rowRaw.replace(/^\s*\|/, '').split('|')[1] || rowRaw;
  const s = cell.replace(/\*/g, ' ').replace(/\s{2,}/g, ' ');
  const low = s.toLowerCase();

  const resources = { hp: false, mp: false, ip: false };
  const martials = { melee: false, ranged: false, armor: false, shields: false };
  const rituals = Object.fromEntries(RITUAL_KINDS.map((k) => [k, false]));
  const parts = [];

  // "HP or MP, your choice" — a boolean can't pick for the player.
  const choiceHpMp = /\bhp\s*or\s*mp\b|\bmp\s*or\s*hp\b|hit points\s*or\s*mind points/i.test(low);

  if (!choiceHpMp) {
    if (/\+\s*\d+\s*(?:max(?:imum)?\s*)?hp\b|maximum hit points/i.test(low)) { resources.hp = true; parts.push('increased maximum Hit Points'); }
    if (/\+\s*\d+\s*(?:max(?:imum)?\s*)?mp\b|maximum mind points/i.test(low)) { resources.mp = true; parts.push('increased maximum Mind Points'); }
  }
  if (/\+\s*\d+\s*(?:max(?:imum)?\s*)?ip\b|maximum inventory points/i.test(low)) { resources.ip = true; parts.push('increased maximum Inventory Points'); }

  // The martial grant may list proficiencies loosely ("martial armor and shields",
  // "martial melee / martial ranged"). Once the cell mentions "martial", read each
  // proficiency word present in the cell (these short benefit cells don't use the
  // words as flavour). "weapons" without a slot word implies no specific slot.
  if (/\bmartial\b/i.test(low)) {
    if (/\bmelee\b/i.test(low)) { martials.melee = true; parts.push('martial melee proficiency'); }
    if (/\branged\b/i.test(low)) { martials.ranged = true; parts.push('martial ranged proficiency'); }
    if (/\barmou?r\b/i.test(low)) { martials.armor = true; parts.push('martial armor proficiency'); }
    if (/\bshields?\b/i.test(low)) { martials.shields = true; parts.push('martial shields proficiency'); }
  }

  for (const k of RITUAL_KINDS) {
    if (new RegExp(`\\b${k}\\b\\s*rituals?|rituals?\\s*of\\s*${k}\\b`, 'i').test(low)) {
      rituals[k] = true; parts.push(`${k[0].toUpperCase() + k.slice(1)} rituals`);
    }
  }

  const any = resources.hp || resources.mp || resources.ip
    || Object.values(martials).some(Boolean) || Object.values(rituals).some(Boolean);
  if (!any && !choiceHpMp) return null;
  return { resources, martials, rituals, choiceHpMp, parts };
}

// ---- PFU counterpart benefit overrides (Path A, Austin ruling 2026-08-20) --------------
// The 25 classes the card left with NO concrete benefit are activated by adopting their
// Project FU counterpart's benefit VALUES (mechanical booleans only — no FU prose). Mapping
// basis per entry: EXACT-NAME (PFU ships the class by that name) or the card's printed_name
// (a stated rename). Values read from projectfu v4.16.1 class data (src/packs/classes).
// Classes with no CONFIDENT PFU counterpart (printed_name points to a 3rd-party/homebrew
// source, or the archetype is ambiguous) are NOT here — they stay flagged for Austin.
const BENEFIT_OVERRIDES = {
  'elementalist': { counterpart: 'Elementalist', basis: 'exact-name',
    resources: { hp: false, mp: true, ip: false },
    martials: { melee: false, ranged: false, armor: false, shields: false },
    rituals: { arcanism: false, chimerism: false, elementalism: false, entropism: false, ritualism: true, spiritism: false } },
  'entropist': { counterpart: 'Entropist', basis: 'exact-name',
    resources: { hp: false, mp: true, ip: false },
    martials: { melee: false, ranged: false, armor: false, shields: false },
    rituals: { arcanism: false, chimerism: false, elementalism: false, entropism: false, ritualism: true, spiritism: false } },
  'fury': { counterpart: 'Fury', basis: 'exact-name',
    resources: { hp: true, mp: false, ip: false },
    martials: { melee: true, ranged: false, armor: true, shields: false },
    rituals: { arcanism: false, chimerism: false, elementalism: false, entropism: false, ritualism: false, spiritism: false } },
  'guardian': { counterpart: 'Guardian', basis: 'exact-name',
    resources: { hp: true, mp: false, ip: false },
    martials: { melee: false, ranged: false, armor: true, shields: true },
    rituals: { arcanism: false, chimerism: false, elementalism: false, entropism: false, ritualism: false, spiritism: false } },
  'orator': { counterpart: 'Orator', basis: 'exact-name',
    resources: { hp: false, mp: true, ip: false },
    martials: { melee: false, ranged: false, armor: false, shields: false },
    rituals: { arcanism: false, chimerism: false, elementalism: false, entropism: false, ritualism: false, spiritism: false } },
  'rogue': { counterpart: 'Rogue', basis: 'exact-name',
    resources: { hp: false, mp: false, ip: true },
    martials: { melee: false, ranged: false, armor: false, shields: false },
    rituals: { arcanism: false, chimerism: false, elementalism: false, entropism: false, ritualism: false, spiritism: false } },
  'sharpshooter': { counterpart: 'Sharpshooter', basis: 'exact-name',
    resources: { hp: true, mp: false, ip: false },
    martials: { melee: false, ranged: true, armor: false, shields: true },
    rituals: { arcanism: false, chimerism: false, elementalism: false, entropism: false, ritualism: false, spiritism: false } },
  'spiritist': { counterpart: 'Spiritist', basis: 'exact-name',
    resources: { hp: false, mp: true, ip: false },
    martials: { melee: false, ranged: false, armor: false, shields: false },
    rituals: { arcanism: false, chimerism: false, elementalism: false, entropism: false, ritualism: true, spiritism: false } },
  'arcanist': { counterpart: 'Arcanist', basis: 'exact-name (our arcanist is the FU Arcanist variant)',
    resources: { hp: false, mp: true, ip: false },
    martials: { melee: false, ranged: false, armor: false, shields: false },
    rituals: { arcanism: false, chimerism: false, elementalism: false, entropism: false, ritualism: false, spiritism: false } },
  'chanter': { counterpart: 'Chanter', basis: 'exact-name (PFU ships Chanter)',
    resources: { hp: false, mp: true, ip: false },
    martials: { melee: false, ranged: false, armor: false, shields: false },
    rituals: { arcanism: false, chimerism: false, elementalism: false, entropism: false, ritualism: false, spiritism: false } },
  'symbolist': { counterpart: 'Symbolist', basis: 'exact-name (PFU ships Symbolist)',
    resources: { hp: false, mp: false, ip: true },
    martials: { melee: false, ranged: false, armor: false, shields: false },
    rituals: { arcanism: false, chimerism: false, elementalism: false, entropism: false, ritualism: false, spiritism: false } },
  'archivist': { counterpart: 'Loremaster', basis: 'card printed_name = Loremaster',
    resources: { hp: false, mp: true, ip: false },
    martials: { melee: false, ranged: false, armor: false, shields: false },
    rituals: { arcanism: false, chimerism: false, elementalism: false, entropism: false, ritualism: false, spiritism: false } },
  'blackguard': { counterpart: 'Darkblade', basis: 'card printed_name = Darkblade',
    resources: { hp: true, mp: false, ip: false },
    martials: { melee: true, ranged: false, armor: true, shields: false },
    rituals: { arcanism: false, chimerism: false, elementalism: false, entropism: false, ritualism: false, spiritism: false } },
  'engineer': { counterpart: 'Tinkerer', basis: 'card printed_name = Tinkerer',
    resources: { hp: false, mp: false, ip: true },
    martials: { melee: false, ranged: false, armor: false, shields: false },
    rituals: { arcanism: false, chimerism: false, elementalism: false, entropism: false, ritualism: false, spiritism: false } },
  'prizefighter': { counterpart: 'Weaponmaster', basis: 'card printed_name = Weaponmaster',
    resources: { hp: true, mp: false, ip: false },
    martials: { melee: true, ranged: false, armor: false, shields: true },
    rituals: { arcanism: false, chimerism: false, elementalism: false, entropism: false, ritualism: false, spiritism: false } },
  'traveller': { counterpart: 'Wayfarer', basis: 'card printed_name = Wayfarer',
    resources: { hp: false, mp: false, ip: true },
    martials: { melee: false, ranged: false, armor: false, shields: false },
    rituals: { arcanism: false, chimerism: false, elementalism: false, entropism: false, ritualism: false, spiritism: false } },
  'vivisectionist': { counterpart: 'Chimerist', basis: 'card printed_name = Chimerist',
    resources: { hp: false, mp: true, ip: false },
    martials: { melee: false, ranged: false, armor: false, shields: false },
    rituals: { arcanism: false, chimerism: false, elementalism: false, entropism: false, ritualism: true, spiritism: false } },
};
const CAP = (s) => s[0].toUpperCase() + s.slice(1);
function benefitsFromOverride(ov) {
  const parts = [];
  if (ov.resources.hp) parts.push('increased maximum Hit Points');
  if (ov.resources.mp) parts.push('increased maximum Mind Points');
  if (ov.resources.ip) parts.push('increased maximum Inventory Points');
  for (const m of ['melee', 'ranged', 'armor', 'shields']) if (ov.martials[m]) parts.push(`martial ${m} proficiency`);
  for (const k of RITUAL_KINDS) if (ov.rituals[k]) parts.push(`${CAP(k)} rituals`);
  return { resources: ov.resources, martials: ov.martials, rituals: ov.rituals, choiceHpMp: false, parts, fromCounterpart: ov.counterpart };
}

// ---- page-cited printed benefit specs (god card FDN-2-benefits-remainder, 2026-08-20) --------
// The compiler extracted the printed FREE BENEFITS box for the 8 remaining inert classes, each
// page-cited to its source PDF. We use these values VERBATIM. Same boolean shape as the rest —
// resources parsed from the freeBenefits prose, martial/ritual taken straight from the spec.
// Two CHOOSE-ONE cases: magistrate (+HP or +MP) uses the established choiceHpMp shape (both left
// false, player picks on the sheet); stalwart (shields always + choose melee OR ranged) has no
// prior choose-one-martial shape, so per god's fallback we ENABLE BOTH options and note the pick.
const SPEC_FILE = join(DOCS, 'benefit-specs-8classes.json');
const BENEFIT_SPECS = {};
if (existsSync(SPEC_FILE)) {
  for (const e of JSON.parse(readFileSync(SPEC_FILE, 'utf8'))) BENEFIT_SPECS[e.key] = e;
}
function benefitsFromSpec(e) {
  const low = (e.freeBenefits || []).join(' | ').toLowerCase();
  const choiceHpMp = /hit points\s*or\s*mind points|mind points\s*or\s*hit points|\bhp\s*or\s*mp\b|\bmp\s*or\s*hp\b/i.test(low);
  const resources = {
    hp: !choiceHpMp && /maximum hit points/i.test(low),
    mp: !choiceHpMp && /maximum mind points/i.test(low),
    ip: /maximum inventory points/i.test(low),
  };
  const martials = { melee: !!e.martial?.melee, ranged: !!e.martial?.ranged, armor: !!e.martial?.armor, shields: !!e.martial?.shields };
  const rituals = Object.fromEntries(RITUAL_KINDS.map((k) => [k, !!e.ritual?.[k]]));
  // choose-one-martial: the printed line grants shields always then "choose one" melee/ranged.
  const chooseOneMartial = (/choose one/i.test(low) && /\bmelee\b/i.test(low) && /\branged\b/i.test(low)) ? ['melee', 'ranged'] : null;
  const chooseSet = new Set(chooseOneMartial || []);
  const parts = [];
  if (resources.hp) parts.push('increased maximum Hit Points');
  if (resources.mp) parts.push('increased maximum Mind Points');
  if (resources.ip) parts.push('increased maximum Inventory Points');
  for (const m of ['melee', 'ranged', 'armor', 'shields']) if (martials[m] && !chooseSet.has(m)) parts.push(`martial ${m} proficiency`);
  for (const k of RITUAL_KINDS) if (rituals[k]) parts.push(`${CAP(k)} rituals`);
  return { resources, martials, rituals, choiceHpMp, chooseOneMartial, parts, fromSpec: { printedName: e.printedName, sourcePdf: e.sourcePdf, page: e.page } };
}

// ---- load ------------------------------------------------------------------------------
const snap = JSON.parse(readFileSync(SNAP, 'utf8'));
const classByKey = Object.fromEntries(snap.classes.map((c) => [c.key, c]));
const dispName = (k) => classByKey[k]?.display_name || titleCase(k);

const flags = [];   // {kind, key, reason} — ambiguity/gap report to Austin/god
const flag = (kind, key, reason) => flags.push({ kind, key, reason });

// ============================================================================
// PACK 1 of 3 — SKILLS (built first so classes can @UUID-link them)
// ============================================================================
rmSync(join(MODULE, 'src', 'packs', 'skills'), { recursive: true, force: true });
mkdirSync(join(MODULE, 'src', 'packs', 'skills'), { recursive: true });

const skillIdByClass = {};   // class_key -> [{name, id, max_sl, summary}]
let si = 0;
for (const r of snap.class_skills) {
  si += 1;
  const _id = id16('RCsk', si);
  const clean = strip(r.summary);
  if (!clean) flag('skill', `${r.class_key}/${r.skill_key}`, 'summary empty after strip — clause may have lived only in commentary; check the row');
  const maxSl = r.max_sl && r.max_sl > 0 ? r.max_sl : 1;
  const item = {
    name: r.display_name,
    type: 'skill',
    _id,
    img: 'icons/svg/upgrade.svg',
    system: {
      fuid: r.skill_key,
      source: { value: `Rippers Unmasked — class_skills (${r.class_key})` },
      subtype: { value: '' },
      summary: { value: (clean.split(/(?<=[.!?])\s/)[0] || clean).slice(0, 120) },
      description: `<p>${esc(clean)}</p>`,
      class: { value: dispName(r.class_key) },
      level: { value: 0, min: 0, max: maxSl },
      hasRoll: { value: false },
    },
    effects: [],
    folder: null,
    flags: { [MODULE_ID]: { classKey: r.class_key, skillKey: r.skill_key, maxSl } },
    _stats: { systemId: 'projectfu', coreVersion: '13.0.0' },
    _key: `!items!${_id}`,
  };
  writeFileSync(join(MODULE, 'src', 'packs', 'skills', `skill_${_id}.json`), JSON.stringify(item, null, '\t'));
  (skillIdByClass[r.class_key] ||= []).push({ name: r.display_name, id: _id, max_sl: r.max_sl, summary: clean });
}

// ============================================================================
// PACK 2 of 3 — HEROICS (requirement listed; synthesised where the text is blank)
// ============================================================================
rmSync(join(MODULE, 'src', 'packs', 'heroics'), { recursive: true, force: true });
mkdirSync(join(MODULE, 'src', 'packs', 'heroics'), { recursive: true });

function synthRequirement(h) {
  const cls = (h.mastery_classes || []).map(dispName);
  const gate = h.class_gate === 'acquired' ? 'acquired' : 'mastery';
  const reqSkills = (h.required_skills || []).map((s) => titleCase(s));
  let base;
  if (cls.length) base = `${cls.join(' or ')} ${gate}`;
  else if (gate === 'mastery') base = 'Master any class';   // FU generic heroic
  else base = '';
  if (reqSkills.length) base += `${base ? '; ' : ''}requires ${reqSkills.join(', ')}`;
  return base;
}

let hi = 0;
for (const h of snap.heroic_skills) {
  hi += 1;
  const _id = id16('RChr', hi);
  const reqText = strip(h.requirements);
  const requirement = reqText || synthRequirement(h);
  if (!reqText) flag('heroic-req', h.key, `requirements text blank — synthesised "${requirement}" from mastery_classes/class_gate/required_skills`);
  const clsLabel = (h.mastery_classes || []).map(dispName).join(' / ') || 'Any';
  const descBits = [`<p>${esc(strip(h.summary))}</p>`];
  if (h.creation_banned) descBits.push('<p><em>GM-gated: not available at character creation.</em></p>');
  const item = {
    name: h.display_name,
    type: 'heroic',
    _id,
    img: 'icons/svg/aura.svg',
    system: {
      fuid: h.key,
      source: { value: 'Rippers Unmasked — heroic_skills' },
      subtype: { value: '' },
      class: { value: clsLabel },
      requirement: { value: requirement },
      description: descBits.join(''),
      hasRoll: { value: false },
    },
    effects: [],
    folder: null,
    flags: { [MODULE_ID]: { heroicKey: h.key, masteryClasses: h.mastery_classes || [], classGate: h.class_gate, creationBanned: !!h.creation_banned, requiredSkills: h.required_skills || [] } },
    _stats: { systemId: 'projectfu', coreVersion: '13.0.0' },
    _key: `!items!${_id}`,
  };
  writeFileSync(join(MODULE, 'src', 'packs', 'heroics', `heroic_${_id}.json`), JSON.stringify(item, null, '\t'));
}

// ============================================================================
// PACK 3 of 3 — CLASSES (skills @UUID-linked; benefits true-with-note)
// ============================================================================
rmSync(join(MODULE, 'src', 'packs', 'classes'), { recursive: true, force: true });
mkdirSync(join(MODULE, 'src', 'packs', 'classes'), { recursive: true });

const HOUSE = '<em>(House note: FU auto-applies this class benefit — the mechanical field is activated on the sheet. Rippers handles class identity through the Guise; the benefit itself is standard Project FU.)</em>';

let ci = 0;
for (const c of snap.classes) {
  ci += 1;
  const _id = id16('RCcl', ci);
  const skills = skillIdByClass[c.key] || [];
  if (!skills.length) flag('class', c.key, 'no class_skills rows — class Item ships with an empty Skills section');

  const also = alsoNames(c.key);
  // Page-cited printed spec (the 8 remaining classes) wins — authoritative, source-verified.
  let bene = BENEFIT_SPECS[c.key] ? benefitsFromSpec(BENEFIT_SPECS[c.key]) : concreteBenefits(c.key);
  if (BENEFIT_SPECS[c.key]) {
    const sp = BENEFIT_SPECS[c.key];
    flag('class-benefit-spec', c.key, `activated from printed FREE BENEFITS — ${sp.printedName} (${sp.sourcePdf}, ${sp.page})${bene.chooseOneMartial ? ' [choose-one melee/ranged: both enabled, player picks]' : ''}${bene.choiceHpMp ? ' [choose-one HP/MP: both false, player picks]' : ''}`);
  }
  // Path A: if the card recorded no concrete benefit but a confident PFU counterpart
  // exists, adopt the counterpart's benefit values (mechanical booleans only).
  if (!bene && BENEFIT_OVERRIDES[c.key]) {
    const ov = BENEFIT_OVERRIDES[c.key];
    bene = benefitsFromOverride(ov);
    flag('class-benefit-override', c.key, `activated from PFU counterpart ${ov.counterpart} (${ov.basis})`);
  }
  const R = bene?.resources || { hp: false, mp: false, ip: false };
  const M = bene?.martials || { melee: false, ranged: false, armor: false, shields: false };
  const T = bene?.rituals || Object.fromEntries(RITUAL_KINDS.map((k) => [k, false]));
  const benefits = {
    resources: { hp: { value: !!R.hp }, mp: { value: !!R.mp }, ip: { value: !!R.ip } },
    martials: { melee: { value: !!M.melee }, ranged: { value: !!M.ranged }, armor: { value: !!M.armor }, shields: { value: !!M.shields } },
    rituals: Object.fromEntries(RITUAL_KINDS.map((k) => [k, { value: !!T[k] }])),
  };
  if (!bene) {
    const hasCard = existsSync(join(DOCS, `CLASSREF-${cardKey(c.key)}.md`));
    flag('class-benefit', c.key, hasCard
      ? 'card states no concrete free benefit ("dead letter"/unrecorded) — flags left false; needs Austin\'s FU benefit list'
      : 'no individual CLASSREF card (core-fifteen class) — benefits not parsed here; standard FU class, activate from FU or Austin\'s list');
  }
  if (bene?.choiceHpMp) flag('class-benefit-choice', c.key, 'card grants "+HP or MP, player\'s choice" — a boolean can\'t pick; both left false, noted in the Item. Player sets one on the sheet');

  // description HTML
  const d = [];
  if (c.printed_name && c.printed_name.toLowerCase() !== c.display_name.toLowerCase()) {
    d.push(`<p><em>Built on Project FU's <strong>${esc(c.printed_name)}</strong>.</em></p>`);
  }
  if (bene && (bene.parts.length || bene.choiceHpMp || bene.chooseOneMartial)) {
    const li = bene.parts.map((p) => `<li>${esc(p)} — activated.</li>`);
    if (bene.choiceHpMp) li.push('<li>Increased maximum HP <strong>or</strong> MP — player\'s choice; set the chosen resource on the sheet.</li>');
    if (bene.chooseOneMartial) {
      const [a, b] = bene.chooseOneMartial;
      li.push(`<li>Martial ${esc(a)} <strong>or</strong> martial ${esc(b)} — player\'s choice of one (both fields are enabled on the Item; disable the one you did not take).</li>`);
    }
    const note = bene.fromSpec
      ? `<em>(House note: printed FREE BENEFITS from <strong>${esc(bene.fromSpec.printedName)}</strong> (${esc(bene.fromSpec.sourcePdf)}, ${esc(bene.fromSpec.page)}) — FU auto-applies the class math; the mechanical fields are activated on the sheet. Rippers handles class identity through the Guise.)</em>`
      : bene.fromCounterpart
        ? `<em>(House note: benefits adopted from Project FU's <strong>${esc(bene.fromCounterpart)}</strong> counterpart — FU auto-applies the class math; the mechanical fields are activated on the sheet. Rippers handles class identity through the Guise.)</em>`
        : HOUSE;
    d.push(`<h5>FREE BENEFITS</h5><ul>${li.join('')}</ul><p>${note}</p>`);
  }
  d.push(`<h2>${esc((c.display_name || '').toUpperCase())} SKILLS</h2>`);
  if (skills.length) {
    for (const s of skills) {
      const badge = s.max_sl && s.max_sl > 0 ? ` <strong>【Max SL ${s.max_sl}】</strong>` : '';
      d.push(`<p>@UUID[Compendium.${MODULE_ID}.skills.Item.${s.id}]{${esc(s.name)}}${badge}</p>`);
      if (s.summary) d.push(`<p>${esc(s.summary)}</p>`);
    }
  } else {
    d.push('<p><em>No class skills recorded.</em></p>');
  }

  const item = {
    name: c.display_name,
    type: 'class',
    _id,
    img: 'icons/svg/book.svg',
    system: {
      fuid: c.key,
      source: { value: `Rippers Unmasked — classes (${c.key})` },
      subtype: { value: '' },
      summary: { value: also ? `Also known as ${also}.` : '' },
      description: d.join(''),
      isFavored: { value: false },
      showTitleCard: { value: false },
      level: { value: 1, min: 0, max: 10 },
      benefits,
    },
    effects: [],
    folder: null,
    flags: { [MODULE_ID]: { classKey: c.key, guiseEligible: GUISE.has(c.key), innateOnly: !!c.is_innate_only, printedName: c.printed_name } },
    _stats: { systemId: 'projectfu', coreVersion: '13.0.0' },
    _key: `!items!${_id}`,
  };
  writeFileSync(join(MODULE, 'src', 'packs', 'classes', `class_${_id}.json`), JSON.stringify(item, null, '\t'));
}

// ---- report ----------------------------------------------------------------------------
console.log(`PACK counts: classes ${ci}, skills ${si}, heroics ${hi}`);
const benefitFlags = flags.filter((f) => f.kind === 'class-benefit');
const choiceFlags = flags.filter((f) => f.kind === 'class-benefit-choice');
const overrideFlags = flags.filter((f) => f.kind === 'class-benefit-override');
const reqFlags = flags.filter((f) => f.kind === 'heroic-req');
const otherFlags = flags.filter((f) => !['class-benefit', 'class-benefit-choice', 'class-benefit-override', 'class-benefit-spec', 'heroic-req'].includes(f.kind));
const specFlags = flags.filter((f) => f.kind === 'class-benefit-spec');
console.log(`\nCLASS BENEFITS activated from a page-cited printed spec (FDN-2): ${specFlags.length}`);
for (const f of specFlags) console.log(`  - ${f.key}: ${f.reason}`);
console.log(`\nCLASS BENEFITS activated from a PFU counterpart (Path A): ${overrideFlags.length}`);
for (const f of overrideFlags) console.log(`  - ${f.key}: ${f.reason}`);
console.log(`\nHeroic requirements SYNTHESISED (blank text) : ${reqFlags.length}`);
for (const f of reqFlags) console.log(`  - ${f.key}: ${f.reason}`);
console.log(`\nCLASS BENEFITS activated (concrete printed benefit read from the card): ${ci - benefitFlags.length}/${ci}`);
console.log(`CLASS BENEFIT flags left false (card states none — needs Austin's list): ${benefitFlags.length}`);
for (const f of benefitFlags) console.log(`  - ${f.key}`);
console.log(`\nPLAYER-CHOICE benefits ("+HP or MP") — left false, noted in Item, player picks: ${choiceFlags.length}`);
for (const f of choiceFlags) console.log(`  - ${f.key}`);
if (otherFlags.length) {
  console.log(`\nOTHER gaps (${otherFlags.length}):`);
  for (const f of otherFlags) console.log(`  - [${f.kind}] ${f.key}: ${f.reason}`);
} else {
  console.log('\nNo skill/class content gaps.');
}
