#!/usr/bin/env node
// print-to-pdf.mjs — render an HTML file to PDF with headless Chrome over the DevTools
// protocol, so we can bake a running footer (page number + version + not-for-redistribution).
// Usage: node tools/print-to-pdf.mjs --html <file.html> --pdf <out.pdf> --footer "text"
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]]);
  return a;
}, []));
const HTML = path.resolve(args.html);
const PDF = path.resolve(args.pdf);
const FOOTER = args.footer || '';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9412 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const udd = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'chrome-print-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', `--user-data-dir=${udd}`, `--remote-debugging-port=${PORT}`, 'about:blank',
], { stdio: 'ignore' });

async function cdp() {
  // wait for the debugging endpoint
  let ver;
  for (let i = 0; i < 60; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
    catch { await sleep(200); }
  }
  if (!ver) throw new Error('Chrome debug endpoint never came up');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0; const pending = new Map(); const events = [];
  const waiters = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) { events.push(msg); waiters.forEach(w => w(msg)); }
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, (r) => r.error ? rej(new Error(method + ': ' + JSON.stringify(r.error))) : res(r.result));
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
  const waitEvent = (method, timeout = 30000) => new Promise((res, rej) => {
    const found = events.find(e => e.method === method);
    if (found) return res(found);
    const t = setTimeout(() => rej(new Error('timeout ' + method)), timeout);
    waiters.push((e) => { if (e.method === method) { clearTimeout(t); res(e); } });
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable');
  await S('Page.navigate', { url: 'file://' + HTML });
  await waitEvent('Page.loadEventFired');
  await sleep(1200); // let embedded webfonts settle before layout

  const { data } = await S('Page.printToPDF', {
    printBackground: true,
    paperWidth: 8.5, paperHeight: 11,
    marginTop: 0.55, marginBottom: 0.75, marginLeft: 0.6, marginRight: 0.6,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate:
      `<div style="width:100%;font-family:'IBM Plex Mono',monospace;font-size:7px;color:#8f0f1a;padding:0 12mm;display:flex;justify-content:space-between;">
         <span>${FOOTER.replace(/"/g, '&quot;')}</span>
         <span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>
       </div>`,
    preferCSSPageSize: false,
  });
  fs.writeFileSync(PDF, Buffer.from(data, 'base64'));
  ws.close();
}

cdp().then(() => { chrome.kill(); fs.rmSync(udd, { recursive: true, force: true }); console.log('PDF written: ' + PDF); })
  .catch((e) => { chrome.kill(); fs.rmSync(udd, { recursive: true, force: true }); console.error('FAILED:', e.message); process.exit(1); });
