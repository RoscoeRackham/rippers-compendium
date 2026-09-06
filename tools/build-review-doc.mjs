#!/usr/bin/env node
// build-review-doc.mjs — render a self-contained, print-ready review document of the
// ENTIRE compendium from its pack SOURCES (src/packs/*.json). Fidelity by construction:
// the same docs that compile into the shipped LevelDB packs are the docs rendered here.
// RENDER-ONLY: zero content edits. @UUID links degrade to plain skill names; ritual
// grants are surfaced from each skill's `flags.rippers-compendium.grantsRitual`. Full
// `system.description` is always used — never the 120-char `system.summary` field.
//
// Usage: node tools/build-review-doc.mjs --src <dir-with-src/packs> --fonts <dir> --out <file.html> --version 0.4.7
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]]);
  return a;
}, []));
const SRC = args.src;
const FONTS = args.fonts;
const OUT = args.out;
const VERSION = args.version || '0.4.7';
const DATE = args.date || new Date().toISOString().slice(0, 10);
if (!SRC || !OUT) { console.error('need --src and --out'); process.exit(2); }

const packDir = (p) => path.join(SRC, 'src', 'packs', p);
const loadPack = (name) => fs.readdirSync(packDir(name)).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(packDir(name), f), 'utf8')));

const classes = loadPack('classes');
const skills = loadPack('skills');
const heroics = loadPack('heroics');
const spells = loadPack('spells');
const journals = loadPack('player-reference');

// --- ritual-grant lookup: skill _id -> discipline string ---------------------------
const grantById = new Map();
const grantCount = {};
for (const s of skills) {
  const g = s.flags?.['rippers-compendium']?.grantsRitual;
  if (g) { grantById.set(s._id, g); grantCount[g] = (grantCount[g] || 0) + 1; }
}

// --- HTML helpers -------------------------------------------------------------------
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Degrade @UUID[...Item.RCxxx]{Label} -> bold label; mark ritual grants inline.
function renderBody(html) {
  return String(html ?? '').replace(
    /@UUID\[[^\]]*\.Item\.([A-Za-z0-9]+)\]\{([^}]*)\}/g,
    (_m, id, label) => {
      const g = grantById.get(id);
      const mark = g ? ` <span class="ritual-mark">⚜ grants ${esc(g)} rituals</span>` : '';
      return `<strong class="skill-name">${esc(label)}</strong>${mark}`;
    }
  );
}
const slug = (s) => 'x' + String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// --- CLASSES: innate-only (alpha) then guise (alpha) --------------------------------
const isInnate = (c) => !!c.flags?.['rippers-compendium']?.innateOnly;
const byName = (a, b) => a.name.localeCompare(b.name);
const innateClasses = classes.filter(isInnate).sort(byName);
const guiseClasses = classes.filter(c => !isInnate(c)).sort(byName);

function classSection(c) {
  const sub = c.system?.summary?.value ? `<p class="aka">${esc(c.system.summary.value)}</p>` : '';
  const tag = isInnate(c) ? '<span class="pill innate">INNATE ONLY</span>' : '<span class="pill guise">GUISE</span>';
  return `<section class="class-page" id="${slug('class-' + c.name)}">
  <h2 class="class-name">${esc(c.name)} ${tag}</h2>
  ${sub}
  <div class="class-body">${renderBody(c.system?.description)}</div>
</section>`;
}

// --- HEROICS (alpha, with requirement) ----------------------------------------------
const heroicsSorted = [...heroics].sort(byName);
function heroicEntry(h) {
  const req = h.system?.requirement?.value?.trim();
  const reqLine = req ? `<p class="req"><span class="req-label">Requires</span> ${esc(req)}</p>` : '';
  return `<div class="heroic-entry"><h4 class="heroic-name">${esc(h.name)}</h4>${reqLine}<div class="entry-body">${renderBody(h.system?.description)}</div></div>`;
}

// --- SPELLS (alpha, with tag line) --------------------------------------------------
const spellsSorted = [...spells].sort(byName);
function spellEntry(s) {
  const sy = s.system || {};
  const bits = [];
  const mp = sy.mpCost?.value ?? sy.mpCost;
  if (mp != null && mp !== '') bits.push(`${esc(mp)} MP`);
  const tgt = sy.target?.value ?? sy.target;
  if (tgt) bits.push(esc(tgt));
  const dur = sy.duration?.value ?? sy.duration;
  if (dur) bits.push(esc(dur));
  if (sy.isOffensive?.value ?? sy.isOffensive) bits.push('offensive');
  const tag = bits.length ? `<p class="spell-tags">${bits.join(' · ')}</p>` : '';
  return `<div class="spell-entry"><h4 class="spell-name">${esc(s.name)}</h4>${tag}<div class="entry-body">${renderBody(sy.description)}</div></div>`;
}

// --- JOURNAL PROSE ------------------------------------------------------------------
const journalByName = new Map(journals.map(j => [j.name, j]));
function journalProse(name) {
  const j = journalByName.get(name);
  if (!j || !Array.isArray(j.pages)) return null;
  const parts = j.pages.map(p => {
    const content = p.text?.content;
    if (!content) return '';
    const head = (p.name && p.name !== name) ? `<h4 class="page-name">${esc(p.name)}</h4>` : '';
    return head + `<div class="entry-body">${renderBody(content)}</div>`;
  }).filter(Boolean);
  return parts.length ? parts.join('\n') : null;
}

// --- FONTS (embed OFL woff2 as data URIs) -------------------------------------------
function fontFace(family, file, weight, style = 'normal') {
  const p = path.join(FONTS, file);
  if (!fs.existsSync(p)) return '';
  const b64 = fs.readFileSync(p).toString('base64');
  return `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${b64}) format('woff2');font-weight:${weight};font-style:${style};font-display:swap;}`;
}
const fonts = FONTS ? [
  fontFace('Pirata One', 'pirataone-400.woff2', 400),
  fontFace('Spectral', 'spectral-400.woff2', 400),
  fontFace('Spectral', 'spectral-400i.woff2', 400, 'italic'),
  fontFace('Spectral', 'spectral-600.woff2', 600),
  fontFace('IBM Plex Mono', 'ibmplexmono-400.woff2', 400),
  fontFace('IBM Plex Mono', 'ibmplexmono-600.woff2', 600),
].join('\n') : '';

// --- TOC ----------------------------------------------------------------------------
const toc = [];
toc.push(`<li class="toc-h">Classes — Innate Only (${innateClasses.length})</li>`);
for (const c of innateClasses) toc.push(`<li><a href="#${slug('class-' + c.name)}">${esc(c.name)}</a></li>`);
toc.push(`<li class="toc-h">Classes — Guise (${guiseClasses.length})</li>`);
for (const c of guiseClasses) toc.push(`<li><a href="#${slug('class-' + c.name)}">${esc(c.name)}</a></li>`);
toc.push(`<li class="toc-h"><a href="#xheroics">Heroic Skills (${heroics.length})</a></li>`);
toc.push(`<li class="toc-h"><a href="#xspells">Spells (${spells.length})</a></li>`);
toc.push(`<li class="toc-h"><a href="#xsubsystems">Shared Subsystems</a></li>`);
toc.push(`<li class="toc-h"><a href="#xarcana">Appendix — Arcana</a></li>`);

// --- SUBSYSTEM & ARCANA journals ----------------------------------------------------
const SUBSYS = ['Keystones', 'Torments', 'Personal Vehicle', 'NPC Spells', 'Pressure and Stagger', 'Appendix — Shared Subsystems'];
const ARCANA = ['Arcanum', 'Arcana Registry'];
const subsysRendered = [], subsysMissing = [];
for (const n of SUBSYS) { const p = journalProse(n); if (p) subsysRendered.push({ n, p }); else subsysMissing.push(n); }
const arcanaRendered = [], arcanaMissing = [];
for (const n of ARCANA) { const p = journalProse(n); if (p) arcanaRendered.push({ n, p }); else arcanaMissing.push(n); }

// --- ASSEMBLE -----------------------------------------------------------------------
const grantSummary = Object.entries(grantCount).map(([k, v]) => `${k}×${v}`).join(', ');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Rippers Unmasked — Compendium Review v${VERSION}</title>
<style>
${fonts}
:root{
  --ink:#1c1512; --ink-soft:#4a3f39; --muted:#726458; --bone:#faf6ee; --bone-line:#e6ddcf;
  --blood:#8f0f1a; --blood-deep:#6d0b14; --gold:#8a6d1f;
}
*{box-sizing:border-box;}
html{ -webkit-print-color-adjust:exact; print-color-adjust:exact; }
body{ margin:0; color:var(--ink); background:#fff;
  font-family:'Spectral',Georgia,'Times New Roman',serif; font-size:10.5pt; line-height:1.5; }
h1,h2,h3,h4,h5{ font-family:'Pirata One','Spectral',serif; font-weight:400; line-height:1.1;
  color:var(--blood-deep); letter-spacing:.01em; margin:0 0 .35em; }
a{ color:var(--blood); text-decoration:none; }
p{ margin:0 0 .55em; }
ul{ margin:.2em 0 .7em 1.1em; padding:0; }
li{ margin:.1em 0; }
strong{ font-weight:600; }
em{ color:var(--ink-soft); }

/* ---- cover ---- */
.cover{ height:9.2in; display:flex; flex-direction:column; justify-content:center; align-items:center;
  text-align:center; page-break-after:always; padding:0 1in; }
.cover .mark{ font-family:'IBM Plex Mono',monospace; font-weight:600; font-size:11pt; letter-spacing:.35em;
  color:#fff; background:var(--blood); padding:.35em .8em; border-radius:3px; }
.cover h1{ font-size:58pt; margin:.35em 0 .1em; color:var(--blood-deep); }
.cover .sub{ font-size:15pt; color:var(--ink-soft); font-style:italic; margin-bottom:1.4em; }
.cover .meta{ font-family:'IBM Plex Mono',monospace; font-size:9.5pt; color:var(--muted); line-height:1.9; }
.cover .notice{ margin-top:2.4em; font-family:'IBM Plex Mono',monospace; font-size:8.5pt; letter-spacing:.08em;
  color:var(--blood-deep); border:1px solid var(--blood); border-radius:3px; padding:.5em 1em; text-transform:uppercase; }

/* ---- toc ---- */
.toc{ page-break-after:always; padding:.3in 0; }
.toc h2{ font-size:26pt; border-bottom:2px solid var(--blood); padding-bottom:.15em; }
.toc ul{ list-style:none; margin:.6em 0; padding:0; columns:2; column-gap:2.4em; }
.toc li{ break-inside:avoid; font-size:9.5pt; }
.toc li a{ color:var(--ink); }
.toc li.toc-h{ font-family:'IBM Plex Mono',monospace; font-weight:600; font-size:8.5pt; letter-spacing:.1em;
  text-transform:uppercase; color:var(--blood-deep); margin-top:.7em; break-after:avoid; }
.toc li.toc-h a{ color:var(--blood-deep); }

/* ---- section headers ---- */
.section-head{ page-break-before:always; }
.section-head h1{ font-size:34pt; color:var(--blood-deep); border-bottom:3px double var(--blood); padding-bottom:.1em; }
.section-head .lede{ font-style:italic; color:var(--muted); margin-top:.3em; }

/* ---- class page ---- */
.class-page{ page-break-before:always; }
.class-name{ font-size:30pt; }
.pill{ font-family:'IBM Plex Mono',monospace; font-size:7.5pt; font-weight:600; letter-spacing:.12em;
  vertical-align:.55em; padding:.15em .5em; border-radius:3px; }
.pill.innate{ color:#fff; background:var(--blood); }
.pill.guise{ color:var(--blood-deep); border:1px solid var(--bone-line); background:var(--bone); }
.aka{ font-family:'IBM Plex Mono',monospace; font-size:8.5pt; color:var(--muted); margin-top:-.3em; margin-bottom:1em; }
.class-body h2{ font-family:'IBM Plex Mono',monospace; font-size:10pt; font-weight:600; letter-spacing:.14em;
  text-transform:uppercase; color:var(--blood-deep); margin:1.1em 0 .5em; border-bottom:1px solid var(--bone-line); padding-bottom:.15em; }
.class-body h5{ font-family:'IBM Plex Mono',monospace; font-size:8.5pt; font-weight:600; letter-spacing:.12em;
  text-transform:uppercase; color:var(--muted); margin:.9em 0 .2em; }
.skill-name{ color:var(--ink); font-weight:600; }
.class-body p{ margin:.15em 0 .7em; }
.ritual-mark, .req-label{ font-family:'IBM Plex Mono',monospace; font-size:7.5pt; font-weight:600;
  letter-spacing:.06em; color:var(--gold); white-space:nowrap; }

/* ---- heroics / spells ---- */
.entry-list{ column-count:1; }
.heroic-entry,.spell-entry{ break-inside:avoid; page-break-inside:avoid; margin:0 0 1em;
  padding-bottom:.7em; border-bottom:1px solid var(--bone-line); }
.heroic-name,.spell-name{ font-family:'Spectral',serif; font-weight:600; font-size:13pt; color:var(--blood-deep); }
.req{ margin:.1em 0 .4em; font-size:9pt; color:var(--ink-soft); }
.spell-tags{ font-family:'IBM Plex Mono',monospace; font-size:8pt; letter-spacing:.04em; color:var(--muted); margin:.1em 0 .4em; }
.entry-body h2,.entry-body h3,.entry-body h4{ font-family:'IBM Plex Mono',monospace; font-size:9pt; font-weight:600;
  letter-spacing:.1em; text-transform:uppercase; color:var(--blood-deep); margin:.8em 0 .3em; }
.page-name{ font-family:'Pirata One',serif; font-size:16pt; color:var(--blood-deep); margin-top:1em; }

/* print page geometry + running footer (baked by Chrome CDP footerTemplate too) */
@page{ size:Letter; margin:16mm 15mm 18mm; }
.toc, .section-head, .class-page{ orphans:3; widows:3; }
</style></head>
<body>

<div class="cover">
  <div class="mark">RIPPERS UNMASKED</div>
  <h1>The Compendium</h1>
  <div class="sub">Complete class, heroic, spell &amp; subsystem review</div>
  <div class="meta">
    module <strong>rippers-compendium</strong> · version <strong>${esc(VERSION)}</strong><br>
    ${classes.length} classes &nbsp;·&nbsp; ${skills.length} class skills &nbsp;·&nbsp; ${heroics.length} heroic skills<br>
    ${spells.length} spells &nbsp;·&nbsp; ritual grants: ${esc(grantSummary || 'none')}<br>
    generated ${esc(DATE)} from the v${esc(VERSION)} tag (git archive)
  </div>
  <div class="notice">Personal-table document — not for redistribution</div>
</div>

<nav class="toc">
  <h2>Contents</h2>
  <ul>${toc.join('')}</ul>
</nav>

<div class="section-head"><h1>Classes</h1><p class="lede">Innate-only classes first, then Guise classes, each alphabetical. Free benefits are printed for reference and are <strong>inert</strong> under the no-innate-benefits rule; live capability comes from the benefit-pick pool and from ritual-granting skills (marked ⚜).</p></div>
${innateClasses.map(classSection).join('\n')}
${guiseClasses.map(classSection).join('\n')}

<div class="section-head" id="xheroics"><h1>Heroic Skills</h1><p class="lede">${heroics.length} heroic skills, alphabetical, each with its requirement.</p></div>
<div class="entry-list">${heroicsSorted.map(heroicEntry).join('\n')}</div>

<div class="section-head" id="xspells"><h1>Spells</h1><p class="lede">${spells.length} spells across every discipline, alphabetical.</p></div>
<div class="entry-list">${spellsSorted.map(spellEntry).join('\n')}</div>

<div class="section-head" id="xsubsystems"><h1>Shared Subsystems</h1><p class="lede">Player-reference journal prose for the systems classes lean on.</p></div>
${subsysRendered.map(s => `<section class="subsys" id="${slug('sub-' + s.n)}"><h2 style="page-break-before:auto;font-family:'Pirata One',serif;font-size:22pt;border-bottom:2px solid var(--blood);color:var(--blood-deep);">${esc(s.n)}</h2>${s.p}</section>`).join('\n')}

<div class="section-head" id="xarcana"><h1>Appendix — Arcana</h1><p class="lede">The bound-Arcana registry and their domains (Austin's standing ruling: Arcana live in an appendix).</p></div>
${arcanaRendered.map(a => `<section class="arcana" id="${slug('arc-' + a.n)}"><h2 style="page-break-before:auto;font-family:'Pirata One',serif;font-size:22pt;border-bottom:2px solid var(--blood);color:var(--blood-deep);">${esc(a.n)}</h2>${a.p}</section>`).join('\n')}

</body></html>`;

fs.writeFileSync(OUT, html);
const report = {
  out: OUT, version: VERSION, date: DATE,
  counts: { classes: classes.length, innate: innateClasses.length, guise: guiseClasses.length,
    skills: skills.length, heroics: heroics.length, spells: spells.length, journals: journals.length },
  ritualGrants: grantCount,
  subsystemsRendered: subsysRendered.map(s => s.n), subsystemsMissing: subsysMissing,
  arcanaRendered: arcanaRendered.map(a => a.n), arcanaMissing,
  bytes: Buffer.byteLength(html),
};
console.log(JSON.stringify(report, null, 2));
