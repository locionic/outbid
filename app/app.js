/* Browse the local outbid.lol snapshot. No dependencies, no build step.
 *
 * Ranking note: the source data stores categoryRank as 1 on all but two rows, so
 * rank here is derived from the site's own stated rule — higher amount wins, and
 * equal amounts keep placement order (the older listing ranks higher).
 */

const DATA = 'data/';
const el = (id) => document.getElementById(id);

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});
const num = new Intl.NumberFormat('en-US');

/* These strings come from a scraped third-party site, so they are untrusted.
 * Escape before they touch innerHTML. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

/* Only link out over http(s). Anything else (javascript:, data:) renders as plain
 * text rather than becoming a live href. */
function safeLink(url) {
  return /^https?:\/\//i.test(String(url ?? '').trim()) ? String(url).trim() : null;
}

function safeImage(url) {
  const u = String(url ?? '').trim();
  if (/^(https?:|data:image\/)/i.test(u)) return u;
  // Local mirror paths were rebased to the repo root by tools/extract.py.
  return u ? '../' + u.replace(/^\/+/, '') : null;
}

const day = (iso) => iso.slice(0, 10);
const bySpend = (a, b) =>
  b.amountCents - a.amountCents || a.createdAt.localeCompare(b.createdAt);

const SORTS = {
  spend: bySpend,
  clicks: (a, b) => b.clickCount - a.clickCount,
  newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
  name: (a, b) => a.displayName.localeCompare(b.displayName),
};

let entries = [];
let categories = [];
let catName = new Map();
let shown = [];   // current view, in display order
let rankOf = new Map();

/* ---------- shareable URL state ----------
 * Filters live in location.hash so a view survives reload and can be pasted to
 * someone else. Written on every render, read on load and on hashchange.
 * Defaults are written as nothing, so an untouched page keeps a clean URL. */
function readState() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('q')) el('q').value = p.get('q');
  if (p.has('category')) el('category').value = p.get('category');
  if (p.get('sort')) el('sort').value = p.get('sort');
}

function writeState() {
  const p = new URLSearchParams();
  if (el('q').value.trim()) p.set('q', el('q').value);
  if (el('category').value) p.set('category', el('category').value);
  if (el('sort').value !== 'spend') p.set('sort', el('sort').value);
  const h = p.toString();
  history.replaceState(null, '', h ? '#' + h : location.pathname + location.search);
}

/* ---------- CSV export ----------
 * The export unit is the *current view*, so search/category/sort apply.
 * RFC 4180: quote a field holding a quote, comma, or newline, and double the quotes.
 * Names and descriptions come from a scraped third-party site and genuinely do
 * contain all three, so this is load-bearing rather than defensive decoration. */
const csvField = (v) => {
  const s = String(v ?? '');
  return /["\n\r,]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

function toCsv() {
  const head = ['Rank', 'Name', 'Description', 'Category', 'Paid USD', 'Clicks', 'Listed', 'URL'];
  const body = shown.map((e) => [
    rankOf.get(e.id), e.displayName, e.description,
    catName.get(e.categorySlug) || e.categorySlug,
    (e.amountCents / 100).toFixed(2), e.clickCount, day(e.createdAt), e.sourceUrl,
  ]);
  return [head, ...body].map((r) => r.map(csvField).join(',')).join('\r\n');
}

function exportCsv() {
  // BOM so Excel renders the em-dashes and curly quotes in these listings correctly.
  const blob = new Blob(['﻿' + toCsv()], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'outbid-leaderboard.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function row(e, rank) {
  const href = safeLink(e.sourceUrl);
  const name = esc(e.displayName);
  const label = href
    ? `<a class="listing-name" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${name}<span class="sr-only"> (opens in a new tab)</span></a>`
    : `<span class="listing-name">${name}</span>`;

  const badge = e.identityType === 'x' ? '<span class="x-badge">X profile</span>' : '';

  const src = safeImage(e.imageUrl);
  const letter = esc((e.displayName || '?').trim().charAt(0));
  const avatar = src
    ? `<img class="avatar" src="${esc(src)}" alt="" width="32" height="32" loading="lazy" onerror="this.remove();this.nextElementSibling.hidden=false"><span class="avatar avatar-fallback" hidden aria-hidden="true">${letter}</span>`
    : `<span class="avatar avatar-fallback" aria-hidden="true">${letter}</span>`;

  return `<tr>
    <td class="num rank">${rank}</td>
    <td><span class="listing">${avatar}<span>
      ${label}${badge}
      <span class="listing-desc">${esc(e.description)}</span>
    </span></span></td>
    <td class="col-cat"><span class="cat">${esc(catName.get(e.categorySlug) || e.categorySlug)}</span></td>
    <td class="num paid">${usd.format(e.amountCents / 100)}</td>
    <td class="num">${num.format(e.clickCount)}</td>
    <td class="date col-date">${day(e.createdAt)}</td>
  </tr>`;
}

function matches(e, needle) {
  return [e.displayName, e.description, e.sourceUrl, e.identityKey]
    .some((f) => String(f ?? '').toLowerCase().includes(needle));
}

/* Category spend panel. One series, so every bar wears the same hue — coloring
 * bars darker-where-bigger would double-encode length as color and burn the one
 * free channel on information the bar already shows. Bars scale to the largest
 * category in the slice, so the panel is self-normalising under any filter. */
function renderCats(rows) {
  const totals = new Map();
  for (const e of rows) {
    const t = totals.get(e.categorySlug) || { cents: 0, n: 0 };
    t.cents += e.amountCents;
    t.n += 1;
    totals.set(e.categorySlug, t);
  }
  const list = [...totals].sort((a, b) => b[1].cents - a[1].cents);
  const max = list.length ? list[0][1].cents : 0;

  el('cat-rows').innerHTML = list
    .map(([slug, t]) => {
      const name = catName.get(slug) || slug;
      return `<tr>
        <td class="cat-name">${esc(name)}</td>
        <td class="cat-bar-col"><span class="cat-bar" style="width:${(t.cents / max) * 100}%"></span></td>
        <td class="num">${usd.format(t.cents / 100)}</td>
      </tr>`;
    })
    .join('');

  const grand = rows.reduce((s, e) => s + e.amountCents, 0);
  el('panel-note').textContent = `${list.length} categor${list.length === 1 ? 'y' : 'ies'} · ${usd.format(grand / 100)} in this view`;
}

function render() {
  const needle = el('q').value.trim().toLowerCase();
  const cat = el('category').value;
  const sorter = SORTS[el('sort').value] || bySpend;

  // Rank reflects position on the board being viewed (all-time, or one category),
  // so it stays stable while the search box narrows the rows.
  const board = (cat ? entries.filter((e) => e.categorySlug === cat) : entries)
    .slice()
    .sort(bySpend);
  rankOf = new Map(board.map((e, i) => [e.id, i + 1]));

  shown = (needle ? board.filter((e) => matches(e, needle)) : board)
    .slice()
    .sort(sorter);

  el('rows').innerHTML = shown.map((e) => row(e, rankOf.get(e.id))).join('');

  const spend = shown.reduce((sum, e) => sum + e.amountCents, 0);
  el('result-count').textContent =
    `${num.format(shown.length)} of ${num.format(entries.length)} listings · ${usd.format(spend / 100)} paid`;
  el('empty').hidden = shown.length > 0;

  renderCats(shown);
  writeState();
}

function stats() {
  const dates = entries.map((e) => e.createdAt).sort();
  el('stat-count').textContent = num.format(entries.length);
  el('stat-spend').textContent =
    usd.format(entries.reduce((a, e) => a + e.amountCents, 0) / 100);
  el('stat-clicks').textContent =
    num.format(entries.reduce((a, e) => a + e.clickCount, 0));
  el('stat-window').textContent = `${day(dates[0])} → ${day(dates[dates.length - 1])}`;
}

function populateCategories() {
  const counts = new Map();
  for (const e of entries) counts.set(e.categorySlug, (counts.get(e.categorySlug) || 0) + 1);
  el('category').innerHTML =
    '<option value="">All categories</option>' +
    categories
      .filter((c) => counts.has(c.slug))
      .map((c) => `<option value="${esc(c.slug)}">${esc(c.name)} (${counts.get(c.slug)})</option>`)
      .join('');
}

function init() {
  const [e, c] = [
    fetch(DATA + 'entries.json').then((r) => r.json()),
    fetch(DATA + 'categories.json').then((r) => r.json()),
  ];
  return Promise.all([e, c]).then(([entriesJson, categoriesJson]) => {
    entries = entriesJson;
    categories = categoriesJson;
    catName = new Map(categories.map((x) => [x.slug, x.name]));

    stats();
    populateCategories();
    readState();
    render();

    el('q').addEventListener('input', render);
    el('category').addEventListener('change', render);
    el('sort').addEventListener('change', render);
    el('export').addEventListener('click', exportCsv);

    // Back/forward between shared views. render() uses replaceState, so it will not
    // re-trigger this; only genuine hash navigation arrives here.
    addEventListener('hashchange', () => { readState(); render(); });
  });
}

init().catch((err) => {
  el('result-count').textContent = 'Could not load data: ' + err.message;
});
