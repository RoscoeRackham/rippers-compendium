// build-journals.mjs — generate a Foundry JournalEntry pack from the verbatim
// player reference, so players/GM can browse all 68 classes + subsystem notes in-world.
//
// SOURCE (text of record, verbatim — formatting only, NO rules edits):
//   ../../lodge-docs/COMPENDIUM-player-reference.md
// Structure: `## INNATE ONLY` and `## GUISE` group headers, one Title-Case `## <Class>`
// per class (68 total), a few ALL-CAPS `## <SUBSYSTEM>` headers that belong to the
// preceding class (Cartomancer's deck rules, Celebrity's entourage), then a `## Heroics`
// section and a shared-subsystem appendix (Arcana, Personal Vehicle, NPC Spells, …).
//
// OUTPUT: src/packs/player-reference/*.json — one JournalEntry per class (page 0 = the
// class body; extra pages for each class-embedded subsystem), one JournalEntry per
// appendix section, and three intra-pack Folders (Innate Only / Guise / Appendix).
// pack.mjs compiles the dir into packs/player-reference (LevelDB). Item packs untouched.
//
// RULINGS (source ambiguities, reported to god):
//  - Editorial glyph marks ✎ ⚠ ⛔ ✅ are STRIPPED as characters only; ALL surrounding
//    prose (including house-ruling text like "SCOPED (house ruling): …") is KEPT. This
//    differs from build-compendium.mjs strip() which drops whole glyph-led sentences —
//    that policy targets terse Item cards; this binder is the full verbatim reference,
//    and its house rulings are rules the player needs.
//  - Consecutive non-blank lines are reflowed into one <p> (the source hard-wraps some
//    paragraphs, e.g. in Heroics). Blank lines and block elements end a paragraph.
//
// Run:  node tools/build-journals.mjs   (also invoked by build-compendium.mjs)
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = dirname(HERE);
const DOCS = join(MODULE, '..', '..', 'lodge-docs');
const SRC = join(DOCS, 'COMPENDIUM-player-reference.md');
const OUT = join(MODULE, 'src', 'packs', 'player-reference');
const MODULE_ID = 'rippers-compendium';

// ---- id helpers (deterministic 16-char alnum, mirrors build-compendium.mjs) -------------
function id16(prefix, n) {
  const p = prefix.replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
  return (p + String(n).padStart(16 - p.length, '0')).slice(0, 16);
}

// ---- markdown -> Foundry HTML -----------------------------------------------------------
const GLYPH_G = /[✎⚠⛔✅]/gu;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Inline: escape, strip editorial glyphs (chars only), then **bold** and *italic*.
function inline(text) {
  let t = esc(text).replace(GLYPH_G, '');
  t = t.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*([^*]+?)\*/g, '<em>$1</em>');
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1');
  return t.trim();
}

const isTableRow = (l) => /^\s*\|/.test(l);
const isSepRow = (l) => l.split('|').every((c) => c.trim() === '' || /^:?-{2,}:?$/.test(c.trim()));
const isBullet = (l) => /^\s*[-*]\s+/.test(l);
const isNumbered = (l) => /^\s*\d+\.\s+/.test(l);

function cells(row) {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

// Convert an array of source lines (a class body / subsystem / appendix section) to HTML.
function mdToHtml(lines) {
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const trimmed = line.trim();
    // blank
    if (trimmed === '') { flush(); i++; continue; }
    // horizontal rule
    if (/^-{3,}$/.test(trimmed)) { flush(); out.push('<hr>'); i++; continue; }
    // headings (### / ####)
    let hm = /^(#{3,4})\s+(.*)$/.exec(trimmed);
    if (hm) { flush(); const lvl = hm[1].length; out.push(`<h${lvl}>${inline(hm[2])}</h${lvl}>`); i++; continue; }
    // table
    if (isTableRow(line) && i + 1 < lines.length && isSepRow(lines[i + 1]) && isTableRow(lines[i + 1])) {
      flush();
      const head = cells(line);
      i += 2; // header + separator
      const body = [];
      while (i < lines.length && isTableRow(lines[i])) { body.push(cells(lines[i])); i++; }
      const thead = `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }
    // unordered list
    if (isBullet(line)) {
      flush();
      const items = [];
      while (i < lines.length && isBullet(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
      out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
      continue;
    }
    // ordered list
    if (isNumbered(line)) {
      flush();
      const items = [];
      while (i < lines.length && isNumbered(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
      out.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`);
      continue;
    }
    // plain text — accumulate into a reflowed paragraph
    para.push(trimmed);
    i++;
  }
  flush();
  return out.join('');
}

// ---- parse the source into classes + appendix ------------------------------------------
function isAllCaps(s) { return /[A-Z]/.test(s) && s === s.toUpperCase(); }

function parse(md) {
  const lines = md.split('\n');
  const classes = [];       // { group:'innate'|'guise', name, pages:[{title,lines}] }
  const appendix = [];      // { name, lines }
  let group = null;         // null until first group header
  let mode = 'classes';     // flips to 'appendix' at `## Heroics`
  let curClass = null;
  let curPage = null;       // current lines sink (page.lines or appendix entry.lines)

  const h2 = /^##\s+(.*)$/;
  for (const raw of lines) {
    const m = h2.exec(raw);
    if (m) {
      const title = m[1].trim();
      if (title === 'INNATE ONLY') { group = 'innate'; curClass = null; curPage = null; continue; }
      if (title === 'GUISE') { group = 'guise'; curClass = null; curPage = null; continue; }
      if (mode === 'classes' && title === 'Heroics') {
        mode = 'appendix';
        const entry = { name: title, lines: [] };
        appendix.push(entry); curPage = entry.lines; curClass = null; continue;
      }
      if (mode === 'appendix') {
        const entry = { name: title, lines: [] };
        appendix.push(entry); curPage = entry.lines; continue;
      }
      // classes region
      if (isAllCaps(title)) {
        // class-embedded subsystem — a new page on the current class's JournalEntry
        if (!curClass) throw new Error(`ALL-CAPS section "${title}" with no parent class`);
        const page = { title, lines: [] };
        curClass.pages.push(page); curPage = page.lines; continue;
      }
      // a new class (Title Case)
      const page = { title, lines: [] };
      curClass = { group, name: title, pages: [page] };
      classes.push(curClass); curPage = page.lines; continue;
    }
    // H1 (the doc title) and any pre-group lines: ignore until a sink exists
    if (/^#\s/.test(raw)) continue;
    if (curPage) curPage.push(raw);
  }
  return { classes, appendix };
}

// ---- emit -------------------------------------------------------------------------------
export function buildJournals() {
  const md = readFileSync(SRC, 'utf8');
  const { classes, appendix } = parse(md);

  // reset output dir
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const STATS = { systemId: 'projectfu', coreVersion: '13.0.0' };
  const docs = [];

  // folders
  const folders = {
    innate: { id: id16('RCfd', 1), name: 'Innate Only', sort: 100000 },
    guise: { id: id16('RCfd', 2), name: 'Guise', sort: 200000 },
    appendix: { id: id16('RCfd', 3), name: 'Appendix — Shared Subsystems', sort: 300000 },
  };
  for (const key of ['innate', 'guise', 'appendix']) {
    const f = folders[key];
    docs.push({
      name: f.name, _id: f.id, type: 'JournalEntry', sorting: 'm', folder: null,
      sort: f.sort, color: '', flags: { [MODULE_ID]: { section: key } },
      _stats: STATS, _key: `!folders!${f.id}`,
    });
  }

  let jn = 0, pn = 0, pageCount = 0;
  const mkPage = (jid, title, lines, sortIdx) => {
    const pid = id16('RCpg', ++pn);
    pageCount++;
    return {
      _id: pid, name: title, type: 'text',
      title: { show: true, level: 1 },
      text: { format: 1, content: mdToHtml(lines), markdown: '' },
      sort: (sortIdx + 1) * 100000,
      flags: {}, _stats: STATS, _key: `!journal.pages!${jid}.${pid}`,
    };
  };

  const emitEntry = (name, folderId, sort, pageSpecs) => {
    const jid = id16('RCje', ++jn);
    const pages = pageSpecs.map((ps, idx) => mkPage(jid, ps.title, ps.lines, idx));
    docs.push({
      name, _id: jid, pages, folder: folderId, sort,
      flags: { [MODULE_ID]: { contentOnly: true } }, _stats: STATS, _key: `!journal!${jid}`,
    });
  };

  // classes — one JournalEntry each, in source order within its folder
  let innateSort = 0, guiseSort = 0;
  for (const c of classes) {
    const folderId = c.group === 'innate' ? folders.innate.id : folders.guise.id;
    const sort = (c.group === 'innate' ? ++innateSort : ++guiseSort) * 100000;
    emitEntry(c.name, folderId, sort, c.pages.map((p, i) => ({ title: i === 0 ? c.name : p.title, lines: p.lines })));
  }

  // appendix — one JournalEntry each
  let appSort = 0;
  for (const a of appendix) {
    emitEntry(a.name, folders.appendix.id, ++appSort * 100000, [{ title: a.name, lines: a.lines }]);
  }

  for (const d of docs) {
    const prefix = d._key.startsWith('!folders!') ? 'folder' : 'journal';
    writeFileSync(join(OUT, `${prefix}_${d._id}.json`), JSON.stringify(d, null, '\t'));
  }

  // report
  const innate = classes.filter((c) => c.group === 'innate');
  const guise = classes.filter((c) => c.group === 'guise');
  const embedded = classes.filter((c) => c.pages.length > 1);
  console.log('\n=== JOURNAL PACK (player-reference) ===');
  console.log(`Classes: ${classes.length}  (innate ${innate.length}, guise ${guise.length})`);
  console.log(`Class-embedded subsystem pages: ${embedded.map((c) => `${c.name} +${c.pages.length - 1}`).join(', ') || 'none'}`);
  console.log(`Appendix entries (${appendix.length}): ${appendix.map((a) => a.name).join(', ')}`);
  console.log(`JournalEntries: ${jn}  (classes ${classes.length} + appendix ${appendix.length})`);
  console.log(`Pages total: ${pageCount}   Folders: 3   Docs written: ${docs.length}`);
  if (classes.length !== 68) console.log(`⚠ EXPECTED 68 classes, got ${classes.length}`);
  return { classes: classes.length, journals: jn, pages: pageCount };
}

// run standalone (space-safe: compare resolved paths, not raw file:// strings)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) buildJournals();
