#!/usr/bin/env node
// build-player-reference.mjs — the PLAYER-FACING reference page for the Rippers compendium.
// Reads data/db-snapshot.json + data/spells-source.json. Invents nothing: every rules value on
// the page comes from those two files. Emits one self-contained HTML file (no network but fonts).
//   node tools/build-player-reference.mjs [outfile]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const snap = JSON.parse(readFileSync(join(ROOT, 'data/db-snapshot.json'), 'utf8'));
const spellsRaw = JSON.parse(readFileSync(join(ROOT, 'data/spells-source.json'), 'utf8'));
const spells = Array.isArray(spellsRaw) ? spellsRaw : (spellsRaw.spells ?? []);
const OUT = process.argv[2] ?? join(ROOT, 'player-reference.html');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, '-').toLowerCase();

// ---- the house-amendment split -------------------------------------------------------------
// A ✎ passage is a HOUSE AMENDMENT and is part of the rule — it is never dropped. It is lifted
// out of the running sentence so the printed rule reads clean, then shown beneath it, marked.
// Measured 2026-09-07: 13 of 534 entries carry one; 11 of those carry actual rules text.
function splitAmendment(text) {
  const t = String(text ?? '').trim();
  if (!t.includes('✎')) return { rule: t, notes: [] };
  // Every ✎ passage is a house amendment. There can be more than one in an entry, and one can
  // sit in the requirements line rather than the summary — both cases are real in the corpus.
  const parts = t.split('✎').map((x) => x.trim());
  let rule = parts.shift();
  const notes = parts.map((x) => {
    // leading "(printed: X) <rule>" form: the parenthetical is the note, the rest rejoins the rule
    const m = x.match(/^\(([^)]*)\)\s*([\s\S]*)$/);
    if (m && m[2].trim()) { rule = (rule + ' ' + m[2].trim()).trim(); return m[1].trim(); }
    return x.replace(/^\((.*)\)$/s, '$1').trim();
  }).filter(Boolean);
  return { rule: rule.trim(), notes };
}

const slLabel = (n) => (n === 1 || n == null ? 'Single level' : 'SL 1–' + n);

// ---- content ---------------------------------------------------------------------------------
const classes = [...snap.classes].sort((a, b) => a.display_name.localeCompare(b.display_name));
const skillsByClass = new Map();
for (const s of snap.class_skills) {
  if (!skillsByClass.has(s.class_key)) skillsByClass.set(s.class_key, []);
  skillsByClass.get(s.class_key).push(s);
}
for (const arr of skillsByClass.values()) arr.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
const heroics = [...snap.heroic_skills].sort((a, b) => a.display_name.localeCompare(b.display_name));
const byDiscipline = new Map();
for (const sp of spells) {
  const d = sp.discipline ?? 'other';
  if (!byDiscipline.has(d)) byDiscipline.set(d, []);
  byDiscipline.get(d).push(sp);
}
for (const arr of byDiscipline.values()) arr.sort((a, b) => a.name.localeCompare(b.name));

const chip = (t, cls = '') => `<span class="chip ${cls}">${esc(t)}</span>`;
const val = (v) => (v && typeof v === 'object' ? v.value : v);

function ruleBlock(summary, effectHtml) {
  const { rule, notes } = splitAmendment(summary);
  let h = '';
  if (rule) h += `<p class="rule">${esc(rule)}</p>`;
  if (effectHtml) h += `<div class="rule extra"><span class="extra-tag">In full</span>${effectHtml}</div>`;
  h += amendBlock(notes);
  return h;
}

const amendBlock = (notes) => (notes || []).length
  ? `<div class="amend"><span class="amend-tag">House amendment</span>` +
    notes.map((n) => `<p>${esc(n)}</p>`).join('') + `</div>`
  : '';

// Requirements are prose, not a tag: a printed requirement runs to a full sentence, and forcing
// it into a nowrap chip pushed the page 1000px sideways. Measured 2026-09-07.
function reqLine(raw) {
  const { rule, notes } = splitAmendment(val(raw));
  if (!rule && !notes.length) return '';
  return (rule ? `<p class="req-line"><span class="req-tag">Requires</span>${esc(rule)}</p>` : '')
    + amendBlock(notes);
}

function skillCard(s) {
  return `<article class="entry" data-name="${esc(s.display_name.toLowerCase())}">
  <header class="entry-h"><h4>${esc(s.display_name)}</h4>${chip(slLabel(s.max_sl), 'sl')}</header>
  ${ruleBlock(s.summary, s.effect_html)}
</article>`;
}

function classSection(c) {
  const sk = skillsByClass.get(c.key) ?? [];
  const marks = [];
  if (c.printed_name && c.printed_name !== c.display_name) marks.push(chip('Printed as ' + c.printed_name, 'printed'));
  if (c.is_innate_only) marks.push(chip('Innate only', 'innate'));
  return `<section class="plate" id="c-${slug(c.key)}" data-name="${esc(c.display_name.toLowerCase())}">
  <header class="plate-h">
    <h3>${esc(c.display_name)}</h3>
    <div class="marks">${marks.join('')}<span class="count">${sk.length} skills</span></div>
  </header>
  <div class="entries">${sk.map(skillCard).join('\n')}</div>
</section>`;
}

function heroicCard(h) {
  const marks = [];
  if (Array.isArray(h.mastery_classes) && h.mastery_classes.length) marks.push(chip('Mastery: ' + h.mastery_classes.join(', '), 'req'));
  if (Array.isArray(h.required_skills) && h.required_skills.length) marks.push(chip('Needs: ' + h.required_skills.join(', '), 'req'));
  if (h.creation_banned) marks.push(chip('Not at character creation', 'warn'));
  return `<article class="entry" data-name="${esc(h.display_name.toLowerCase())}">
  <header class="entry-h"><h4>${esc(h.display_name)}</h4></header>
  ${marks.length ? `<div class="marks">${marks.join('')}</div>` : ''}
  ${reqLine(h.requirements)}
  ${h.class_gate ? reqLine(h.class_gate) : ''}
  ${ruleBlock(h.summary, h.effect_html)}
</article>`;
}

function spellCard(sp) {
  const marks = [
    chip((val(sp.mpCost) ?? '?') + ' MP' + (sp.perTarget ? ' per target' : ''), 'mp'),
    chip(val(sp.target) ?? '—', 'req'),
    chip(val(sp.duration) ?? '—', 'req'),
  ];
  if (val(sp.isOffensive)) marks.push(chip('Offensive', 'warn'));
  return `<article class="entry" data-name="${esc(sp.name.toLowerCase())}">
  <header class="entry-h"><h4>${esc(sp.name)}</h4></header>
  <div class="marks">${marks.join('')}</div>
  ${ruleBlock(sp.effect, sp.effectHtml)}
</article>`;
}

const railClasses = classes.map((c) => `<a href="#c-${slug(c.key)}" data-name="${esc(c.display_name.toLowerCase())}">${esc(c.display_name)}</a>`).join('');

const html = `<title>The Lodge Player Reference</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Grenze+Gotisch:wght@700;800;900&family=IBM+Plex+Mono:wght@400;500;600&family=Pirata+One&family=Spectral:ital,wght@0,400;0,600;1,400&display=swap">
<style>
/* The Slash register. Blood is the only register — no second palette, by ruling.
   Values sourced from SLASH-REGISTER-SPEC.md §2a/§3 and the canon register skill. */
:root{
  --bone:#e8dccb; --bone-2:#d8cbb2; --panel:#f2e9d8; --ink:#0b0607;
  --blood:#c8102a; --blood-dark:#8c1c26; --dried:#5c2630;
  --black:#0d0709; --blacker:#0a0507; --gold:#efe0a0; --cool:#6a5850;
  --shadow:#08050a;
  --rail:280px;
  --font-display:'Grenze Gotisch',Georgia,serif;
  --font-ui:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  --font-chrome:'Pirata One',var(--font-display);
  /* Reading face. The register's fourth face — rippers-theme/styles/fonts.css ships Spectral
     400/400i/600 and nothing else, so those are the only weights used here.
     Owner granted the deviation from mono body for this surface on 2026-09-07. */
  --font-read:'Spectral',Georgia,'Times New Roman',serif;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bone);color:var(--ink);font-family:var(--font-ui);
  font-size:15px;line-height:1.65;-webkit-font-smoothing:antialiased}
a{color:inherit}

/* ---- the rail ---- */
.rail{position:fixed;inset:0 auto 0 0;width:var(--rail);background:var(--black);
  color:var(--bone);display:flex;flex-direction:column;border-right:3px solid var(--ink);z-index:10}
.mark{padding:20px 20px 14px;border-bottom:1px solid #29141a;flex:0 0 auto}
.mark b{display:block;font-family:var(--font-chrome);font-size:30px;line-height:1;
  color:var(--bone);letter-spacing:.5px}
.mark i{display:block;font-style:normal;font-family:var(--font-ui);font-size:10px;
  letter-spacing:.18em;text-transform:uppercase;color:var(--cool);margin-top:8px}
.slash{height:10px;margin:12px 0 0;background:var(--blood);
  clip-path:polygon(0 46%,12% 30%,34% 42%,58% 26%,78% 40%,100% 28%,96% 54%,74% 66%,52% 52%,30% 70%,10% 58%);
  transform:rotate(-1.5deg)}
.find{padding:14px 16px;border-bottom:1px solid #29141a;flex:0 0 auto}
.find input{width:100%;background:var(--blacker);border:1px solid #29141a;color:var(--bone);
  font-family:var(--font-ui);font-size:13px;padding:9px 10px;border-radius:0}
.find input::placeholder{color:var(--cool)}
.find input:focus{outline:2px solid var(--blood);outline-offset:1px}
.rail nav{overflow-y:auto;padding:10px 0 40px;flex:1 1 auto}
.rail .grp{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--cool);
  padding:16px 20px 6px}
.rail nav a{display:block;padding:5px 20px;font-family:var(--font-display);font-weight:700;
  font-size:17px;line-height:1.3;text-decoration:none;color:var(--bone-2)}
.rail nav a:hover,.rail nav a:focus-visible{background:var(--blood);color:var(--bone);outline:none}
.rail nav a.hide{display:none}

/* ---- the page ---- */
main{margin-left:var(--rail);padding:0 0 120px;min-width:0;overflow-x:clip}
.intro{background:var(--panel);border-bottom:3px solid var(--ink);padding:56px 48px 44px}
.intro h1{font-family:var(--font-chrome);font-size:clamp(40px,6vw,72px);line-height:1;margin:0;
  text-wrap:balance}
.intro p{max-width:56ch;margin:18px 0 0;color:#241a1c}
.intro .tally{display:flex;flex-wrap:wrap;gap:10px;margin-top:26px}
.intro .tally span{background:var(--ink);color:var(--bone);padding:6px 11px;font-size:11px;
  letter-spacing:.12em;text-transform:uppercase;font-variant-numeric:tabular-nums}

h2.band{font-family:var(--font-chrome);font-size:34px;margin:0;padding:18px 48px;
  background:var(--ink);color:var(--bone);letter-spacing:.5px;position:sticky;top:0;z-index:5}
.wrap{padding:0 48px}

.plate{background:var(--panel);border:2px solid var(--ink);margin:32px 0;
  box-shadow:8px 8px 0 var(--shadow)}
.plate.hide{display:none}
.plate-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:14px;
  padding:18px 24px;border-bottom:2px solid var(--ink);background:var(--bone)}
.plate-h h3{font-family:var(--font-display);font-weight:800;font-size:32px;line-height:1.3;margin:0}
.marks{display:flex;flex-wrap:wrap;gap:7px;align-items:center}
.chip{font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:4px 8px;
  border:1px solid var(--cool);color:#3a2c2c;background:transparent;
  max-width:100%;overflow-wrap:anywhere}
.chip.sl,.chip.mp{white-space:nowrap}
.chip.sl{border-color:var(--ink);color:var(--ink);font-variant-numeric:tabular-nums}
.chip.printed{border-style:dashed}
.chip.innate,.chip.warn{border-color:var(--blood);color:var(--blood-dark);font-weight:600}
.chip.mp{border-color:var(--ink);background:var(--ink);color:var(--bone);font-variant-numeric:tabular-nums}
.count{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--cool);
  margin-left:auto;font-variant-numeric:tabular-nums}

.entries{display:flex;flex-direction:column}
.entry{padding:20px 24px;border-top:1px solid #cbbca6}
.entry:first-child{border-top:none}
.entry.hide{display:none}
.entry-h{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.entry-h h4{font-family:var(--font-display);font-weight:700;font-size:23px;line-height:1.3;margin:0}
.rule,.req-line,.amend p,.intro p{font-family:var(--font-read);font-size:17px;line-height:1.6}
.rule{margin:10px 0 0;max-width:58ch}
.rule.extra{color:#3a2c2c;font-family:var(--font-read);font-size:15.5px;line-height:1.58;
  margin-top:14px;padding-top:12px;border-top:1px dotted #bfae97;max-width:58ch}
.rule.extra p{font-family:var(--font-read)}
.extra-tag{display:block;font-size:11px;letter-spacing:.16em;text-transform:uppercase;
  color:var(--cool);margin-bottom:5px}
.rule.extra p{margin:8px 0 0}
.entry .marks{margin-top:9px}

.amend{margin:12px 0 0;padding:10px 0 10px 14px;border-left:3px solid var(--blood);max-width:60ch}
.amend-tag{display:block;font-size:11px;letter-spacing:.16em;text-transform:uppercase;
  color:var(--blood-dark);font-weight:600;margin-bottom:4px}
.amend p{margin:0;font-size:15.5px;line-height:1.58;color:#3a2c2c}
.amend p + p{margin-top:7px}
.req-line{margin:10px 0 0;max-width:58ch;font-size:15.5px;color:#3a2c2c}
.req-tag{display:inline-block;font-size:11px;letter-spacing:.16em;text-transform:uppercase;
  color:var(--cool);margin-right:9px}

.grid2{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(420px,100%),1fr));gap:0}
.empty{padding:40px 48px;color:var(--cool)}
footer{margin-left:var(--rail);padding:32px 48px 60px;border-top:2px solid var(--ink);
  background:var(--bone-2);font-size:12px;color:#3a2c2c}
footer b{font-family:var(--font-display);font-weight:700;font-size:16px;display:block;margin-bottom:6px}

@media (max-width:700px){
  .rule,.req-line,.amend p,.intro p{font-size:17.5px;line-height:1.65}
  .rule.extra,.rule.extra p{font-size:16px;line-height:1.62}
  .entry{padding:18px 16px}
  .plate-h{padding:16px 16px}
}
@media (max-width:900px){
  :root{--rail:0px}
  .rail{position:static;width:auto;inset:auto}
  .rail nav{max-height:220px}
  main,footer{margin-left:0}
  .intro,.wrap,h2.band,footer{padding-left:20px;padding-right:20px}
}
@media print{
  .rail{display:none} main,footer{margin-left:0}
  .plate{box-shadow:none;break-inside:avoid} h2.band{position:static}
  body{background:#fff}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>

<aside class="rail">
  <div class="mark">
    <b>Rippers Unmasked</b>
    <i>Player reference · the Lodge</i>
    <div class="slash"></div>
  </div>
  <div class="find">
    <label for="q" style="position:absolute;left:-9999px">Find a class, skill or spell</label>
    <input id="q" type="search" placeholder="Find a class or skill…" autocomplete="off">
  </div>
  <nav>
    <div class="grp">Classes</div>
    ${railClasses}
    <div class="grp">Also here</div>
    <a href="#heroics">Heroic skills</a>
    <a href="#spells">Spells</a>
  </nav>
</aside>

<main>
  <div class="intro">
    <h1>The Lodge Player Reference</h1>
    <p>Every class the Lodge will let you take, every skill those classes teach, the heroic skills
    you can earn, and the spells they cast. Read the rule; where the Lodge has changed a printed
    rule, the change is marked beneath it in red, and it is part of the rule.</p>
    <div class="tally">
      <span>${classes.length} classes</span>
      <span>${snap.class_skills.length} class skills</span>
      <span>${heroics.length} heroic skills</span>
      <span>${spells.length} spells</span>
    </div>
  </div>

  <h2 class="band">Classes</h2>
  <div class="wrap" id="classes">${classes.map(classSection).join('\n')}</div>

  <h2 class="band" id="heroics">Heroic skills</h2>
  <div class="wrap">
    <section class="plate">
      <header class="plate-h"><h3>Heroic skills</h3>
        <div class="marks"><span class="count">${heroics.length} skills</span></div></header>
      <div class="entries grid2">${heroics.map(heroicCard).join('\n')}</div>
    </section>
  </div>

  <h2 class="band" id="spells">Spells</h2>
  <div class="wrap">
    ${[...byDiscipline.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, list]) => `
    <section class="plate" data-name="${esc(d)}">
      <header class="plate-h"><h3>${esc(d.charAt(0).toUpperCase() + d.slice(1))}</h3>
        <div class="marks"><span class="count">${list.length} spells</span></div></header>
      <div class="entries grid2">${list.map(spellCard).join('\n')}</div>
    </section>`).join('\n')}
  </div>
  <p class="empty" id="none" hidden>Nothing here matches that. Try a shorter word.</p>
</main>

<footer>
  <b>Where this comes from</b>
  Built from the Rippers compendium snapshot of the Lodge's own records
  (<code>${esc(snap.generated_from)}</code>) on ${new Date().toISOString().slice(0, 10)}.
  Nothing on this page was written for it: every rule, level cap and cost is reproduced from that
  record. <em>Fabula Ultima</em> is © Need Games and Rooster Games, created by Emanuele Galletto;
  the Rippers material is this table's own, layered on Project FU.
</footer>

<script>
(function(){
  var q=document.getElementById('q'), none=document.getElementById('none');
  var plates=[].slice.call(document.querySelectorAll('.plate'));
  var links=[].slice.call(document.querySelectorAll('.rail nav a[data-name]'));
  function run(){
    var t=q.value.trim().toLowerCase(); var any=false;
    plates.forEach(function(p){
      var pn=(p.dataset.name||''); var entries=[].slice.call(p.querySelectorAll('.entry'));
      var hitPlate=!t||pn.indexOf(t)>-1; var shown=0;
      entries.forEach(function(e){
        var hit=!t||hitPlate||(e.dataset.name||'').indexOf(t)>-1||
                e.textContent.toLowerCase().indexOf(t)>-1;
        e.classList.toggle('hide',!hit); if(hit) shown++;
      });
      var vis=!t||hitPlate||shown>0;
      p.classList.toggle('hide',!vis); if(vis) any=true;
    });
    links.forEach(function(a){a.classList.toggle('hide', !!t && a.dataset.name.indexOf(t)===-1);});
    none.hidden=any;
  }
  q.addEventListener('input',run);
})();
</script>`;

writeFileSync(OUT, html);
console.log('wrote ' + OUT + '  ' + (Buffer.byteLength(html) / 1024).toFixed(0) + ' KB');
console.log(classes.length + ' classes, ' + snap.class_skills.length + ' class skills, ' +
  heroics.length + ' heroics, ' + spells.length + ' spells');
