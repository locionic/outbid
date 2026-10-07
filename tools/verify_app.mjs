// Drives the app in headless Chrome over CDP and asserts on what Phase 2 added.
//
// Stdlib only — Node 22's built-in WebSocket, no puppeteer, no npm install.
// Self-contained: starts its own static server, tears it down on the way out.
//
//   node tools/verify_app.mjs        # exits non-zero on any failure
//
// Phase 1's Python suite covers the extractor. This covers the browser half,
// which otherwise has no check: CSV quoting and the hash codec are parsers, and
// parsers without a test are how CSVs turn into silent data loss.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8123;
const CDP_PORT = 9334;
const URL_APP = `http://127.0.0.1:${PORT}/app/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- assertions ----------
let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const eq = (name, actual, expected) =>
  ok(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// ---------- static server ----------
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: ROOT, stdio: 'ignore',
});

const chrome = spawn('google-chrome', [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  '--disable-gpu', '--disable-dev-shm-usage',
  '--window-size=1500,1200', 'about:blank',
], { stdio: 'ignore' });

function cleanup() {
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
}
process.on('exit', cleanup);

async function targetWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const page = (await r.json()).find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('chrome did not come up');
}

const ws = new WebSocket(await targetWs());
await new Promise((res) => { ws.onopen = res; });

let id = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method === 'Log.entryAdded') {
    logs.push(msg.params.entry);
  }
};

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} :: ${expression.slice(0, 80)}`);
  return r.result.value;
};

const setVal = (sel, val) => `(() => {
  const n = document.querySelector('${sel}');
  n.value = ${JSON.stringify(val)};
  n.dispatchEvent(new Event('input', {bubbles:true}));
  n.dispatchEvent(new Event('change', {bubbles:true}));
  return true;
})()`;

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Page.navigate', { url: URL_APP });

// Wait for the app to have rendered rather than sleeping a fixed amount. The
// first evaluations land on about:blank, where #rows does not exist yet, so the
// poll has to tolerate a throw rather than treating it as a failure.
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    if (await evaluate('document.getElementById("rows").children.length > 0')) { ready = true; break; }
  } catch {}
  await sleep(250);
}
if (!ready) { console.error('\napp never rendered; giving up\n'); process.exit(1); }

console.log('\nP2.1  category spend panel');
{
  // The panel is collapsed by default, so its contents have no layout box until
  // it is open. Open it before measuring geometry.
  await evaluate(`document.getElementById('panel').open = true`);

  const p = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#cat-rows tr')];
    const bars = rows.map(r => r.querySelector('.cat-bar'));
    const widths = bars.map(b => b.getBoundingClientRect().width);
    const mid = document.querySelectorAll('.cats thead th')[1];
    return {
      count: rows.length,
      hues: [...new Set(bars.map(b => getComputedStyle(b).backgroundColor))],
      radius: [...new Set(bars.map(b => getComputedStyle(b).borderRadius))],
      heights: [...new Set(bars.map(b => b.getBoundingClientRect().height))],
      maxWidth: Math.max(...widths),
      minWidth: Math.min(...widths.filter((w) => w > 0)),
      sum: rows.reduce((s, r) => s + Math.round(
        r.querySelector('.num').textContent.replace(/[^0-9.]/g,'').replace(/,/g,'') * 100), 0),
      scope: [...document.querySelectorAll('.cats thead th')].map(t => t.getAttribute('scope')),
      // Visible text of the middle header, i.e. excluding the .sr-only label.
      midVisible: [...mid.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim(),
      midHasSrLabel: !!mid.querySelector('.sr-only'),
    };
  })()`);

  eq('one bar per populated category', p.count, 27);
  eq('single hue for every bar (one series, not a ramp)', p.hues.length, 1);
  ok('rounded end is on the right only',
     p.radius[0].startsWith('0px') && p.radius[0].includes('4px'),
     `border-radius: ${p.radius.join()}`);
  ok('bar under the 24px cap', p.heights.every((h) => h > 0 && h <= 24), `heights: ${p.heights.join()}`);
  ok('longest bar fills its column', p.maxWidth > 200, `maxWidth ${p.maxWidth}`);
  ok('bars vary with spend', p.minWidth < p.maxWidth, `min ${p.minWidth} vs max ${p.maxWidth}`);
  ok('panel sum is non-zero', p.sum > 0, `sum ${p.sum}`);
  eq('table headers are scoped', p.scope.join(), 'col,col,col');
  eq('middle header shows no visible text', p.midVisible, '');
  ok('middle header still names itself for AT', p.midHasSrLabel);

  // The panel must track the filter rather than sit beside it.
  const before = p.sum;
  await evaluate(setVal('#category', 'developer-tools'));
  eq('panel collapses to one category under the filter',
     await evaluate(`document.querySelectorAll('#cat-rows tr').length`), 1);
  const filteredSum = await evaluate(`(() => Math.round(
    document.querySelector('#cat-rows .num').textContent.replace(/[^0-9.]/g,'').replace(/,/g,'') * 100))()`);
  ok('filtered panel total differs from the unfiltered one', filteredSum < before, `${filteredSum} vs ${before}`);
  await evaluate(setVal('#category', ''));
}

console.log('\nP2.2  CSV export');
{
  // Synthetic inputs: the real corpus may not contain a newline or a quote, and
  // a quoting bug that never sees one would pass a data-dependent test.
  const esc = await evaluate(`[
    csvField('plain'),
    csvField('a,b'),
    csvField('say "hi"'),
    csvField('line1\\nline2'),
    csvField('cr\\rlf'),
  ]`);
  eq('plain field unquoted', esc[0], 'plain');
  eq('comma wraps', esc[1], '"a,b"');
  eq('quote is doubled', esc[2], '"say ""hi"""');
  eq('newline wraps', esc[3], '"line1\nline2"');
  eq('carriage return wraps', esc[4], '"cr\rlf"');

  const csv = await evaluate('toCsv()');
  const lines = csv.split('\r\n');
  const shownRows = await evaluate('document.getElementById("rows").children.length');
  eq('header row', lines[0], 'Rank,Name,Description,Category,Paid USD,Clicks,Est CPC USD,Listed,URL');
  eq('one line per visible row', lines.length, shownRows + 1);
  ok('CRLF line endings, not bare LF', !/(^|[^\r])\n/.test(csv));
  ok('dates are ISO days', /,\d{4}-\d{2}-\d{2},https?:/.test(lines[1]), lines[1].slice(0, 120));
  ok('amounts carry cents', /,[\d,]+\.\d{2},\d+,/.test(lines[1]));

  // Export unit is the current view, so a filter must shrink it.
  await evaluate(setVal('#q', 'outrank'));
  const narrow = (await evaluate('toCsv()')).split('\r\n');
  ok('export follows the search filter', narrow.length < lines.length, `${narrow.length} vs ${lines.length}`);
  await evaluate(setVal('#q', ''));
}

console.log('\nP2.3  shareable URL state');
{
  eq('default view keeps a clean URL', await evaluate('location.hash'), '');

  await evaluate(setVal('#category', 'developer-tools'));
  ok('category is reflected in the hash',
     (await evaluate('location.hash')).includes('category=developer-tools'));

  await evaluate(setVal('#sort', 'clicks'));
  ok('non-default sort is reflected', (await evaluate('location.hash')).includes('sort=clicks'));

  // Round-trip: wipe the controls, restore from the hash alone.
  const restored = await evaluate(`(() => {
    document.querySelector('#category').value = '';
    document.querySelector('#sort').value = 'spend';
    readState();
    return { cat: document.querySelector('#category').value, sort: document.querySelector('#sort').value };
  })()`);
  eq('category survives a round-trip', restored.cat, 'developer-tools');
  eq('sort survives a round-trip', restored.sort, 'clicks');

  // Back to a clean URL for the checks below.
  await evaluate(`(() => {
    document.querySelector('#category').value = '';
    document.querySelector('#sort').value = 'spend';
    render();
  })()`);
  eq('cleared state leaves a clean URL', await evaluate('location.hash'), '');
}

console.log('\nP2.4  UI polish');
{
  const sticky = await evaluate(`(() => {
    const s = getComputedStyle(document.querySelector('thead th'));
    return { pos: s.position, top: s.top };
  })()`);
  eq('table header is sticky', sticky.pos, 'sticky');

  const figs = await evaluate(`(() => ({
    stat: getComputedStyle(document.getElementById('stat-count')).fontVariantNumeric,
    num:  getComputedStyle(document.querySelector('#rows td.num')).fontVariantNumeric,
  }))()`);
  ok('stat tiles use proportional figures', !figs.stat.includes('tabular-nums'), figs.stat);
  ok('table columns keep tabular figures', figs.num.includes('tabular-nums'), figs.num);

  ok('every control is keyboard reachable', await evaluate(`(() => {
    const ids = ['q', 'category', 'sort', 'export'];
    return ids.every((i) => {
      const e = document.getElementById(i);
      e.focus();
      return document.activeElement === e;
    });
  })()`));
}

console.log('\nRegression — Phase 1 surface');
{
  const s = await evaluate(`({
    count:  document.getElementById('stat-count').textContent,
    spend:  document.getElementById('stat-spend').textContent,
    clicks: document.getElementById('stat-clicks').textContent,
    rows:   document.getElementById('rows').children.length,
  })`);
  eq('listing count', s.count, '1,273');
  eq('total paid', s.spend, '$240,118');
  eq('total clicks', s.clicks, '339,255');
  eq('rows rendered', s.rows, 1273);

  const imgs = await evaluate(`(() => {
    const i = [...document.querySelectorAll('img.avatar')];
    return { total: i.length, broken: i.filter(x => x.complete && x.naturalWidth === 0).length };
  })()`);
  ok('no broken images', imgs.broken === 0, `${imgs.broken} of ${imgs.total} broken`);

  await evaluate(setVal('#category', 'developer-tools'));
  const top = await evaluate(`(() => {
    // The name cell carries an .sr-only "(opens in a new tab)"; drop sr-only
    // nodes so this compares the visible name, not the accessible name.
    const el = document.querySelector('#rows .listing-name');
    const a = el.cloneNode(true);
    a.querySelectorAll('.sr-only').forEach(n => n.remove());
    return {
      name: a.textContent.trim(),
      paid: document.querySelectorAll('#rows td')[3].textContent.trim(),
    };
  })()`);
  // The full displayName includes a tagline; Phase 1's harness truncated it.
  eq('developer-tools leader is unchanged', top.name, 'Modulate | Frontier voice AI company');
  ok('sr-only suffix was stripped, not compared',
     !top.name.includes('opens in a new tab'), `got ${JSON.stringify(top.name)}`);
  eq('developer-tools leader amount unchanged', top.paid, '$3,560');
  await evaluate(setVal('#category', ''));

  const errs = logs.filter((l) => l.level === 'error');
  eq('no console errors', errs.length, 0);
  errs.slice(0, 3).forEach((e) => console.log(`       ${e.text}`));
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall checks passed\n');
ws.close();
process.exit(failures ? 1 : 0);
