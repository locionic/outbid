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

/* Cost per click calculation in USD. Returns null if clicks are zero or invalid. */
function calcCpc(e) {
  if (!e.clickCount || e.clickCount <= 0) return null;
  return (e.amountCents / e.clickCount) / 100;
}

function formatCpc(e) {
  const c = calcCpc(e);
  if (c === null) return '—';
  if (c < 0.01) return '<$0.01';
  return '$' + c.toFixed(2);
}

const SORTS = {
  spend: bySpend,
  clicks: (a, b) => b.clickCount - a.clickCount || bySpend(a, b),
  cpc_asc: (a, b) => {
    const ca = calcCpc(a);
    const cb = calcCpc(b);
    if (ca === null && cb === null) return bySpend(a, b);
    if (ca === null) return 1;
    if (cb === null) return -1;
    return ca - cb || bySpend(a, b);
  },
  cpc_desc: (a, b) => {
    const ca = calcCpc(a);
    const cb = calcCpc(b);
    if (ca === null && cb === null) return bySpend(a, b);
    if (ca === null) return 1;
    if (cb === null) return -1;
    return cb - ca || bySpend(a, b);
  },
  newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
  name: (a, b) => a.displayName.localeCompare(b.displayName),
};

let entries = [];
let categories = [];
let catName = new Map();
let shown = [];   // current view, in display order
let rankOf = new Map();
let overallRankOf = new Map();
let categoryRankOf = new Map();
let catCounts = new Map();
let activeModalId = null;

function computeRanks() {
  const sorted = entries.slice().sort(bySpend);
  overallRankOf = new Map(sorted.map((e, i) => [e.id, i + 1]));

  const byCat = new Map();
  for (const e of sorted) {
    if (!byCat.has(e.categorySlug)) byCat.set(e.categorySlug, []);
    byCat.get(e.categorySlug).push(e);
  }
  categoryRankOf = new Map();
  catCounts = new Map();
  for (const [slug, list] of byCat.entries()) {
    catCounts.set(slug, list.length);
    list.forEach((e, i) => categoryRankOf.set(e.id, i + 1));
  }
  categoryBoards = byCat;
}

/* The category boards themselves, in board order (spend desc), cached so the
 * search box can re-filter one without rebuilding it. Ten categories, so a Map of
 * arrays costs nothing next to the filter that reads it. */
let categoryBoards = new Map();
const categoryBoard = (slug) => categoryBoards.get(slug) || [];

/* ---------- shareable URL state ----------
 * Filters live in location.hash so a view survives reload and can be pasted to
 * someone else. Written on every render, read on load and on hashchange.
 * Defaults are written as nothing, so an untouched page keeps a clean URL. */
function readState() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('q')) el('q').value = p.get('q');
  if (p.has('category')) el('category').value = p.get('category');
  if (p.get('tier')) el('tier').value = p.get('tier');
  if (p.get('platform')) el('platform').value = p.get('platform');
  if (p.get('sort')) el('sort').value = p.get('sort');

  const itemId = p.get('item');
  if (itemId) {
    const item = entries.find((x) => x.id === itemId);
    if (item) openDetail(item, false);
  } else if (activeModalId) {
    closeModal(false);
  }
}

function writeState() {
  const p = new URLSearchParams();
  if (el('q').value.trim()) p.set('q', el('q').value);
  if (el('category').value) p.set('category', el('category').value);
  if (el('tier').value) p.set('tier', el('tier').value);
  if (el('platform').value) p.set('platform', el('platform').value);
  if (el('sort').value !== 'spend') p.set('sort', el('sort').value);
  if (activeModalId) p.set('item', activeModalId);
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
  const head = ['Rank', 'Name', 'Description', 'Category', 'Paid USD', 'Clicks', 'Est CPC USD', 'Listed', 'URL'];
  const body = shown.map((e) => {
    const c = calcCpc(e);
    return [
      rankOf.get(e.id), e.displayName, e.description,
      catName.get(e.categorySlug) || e.categorySlug,
      (e.amountCents / 100).toFixed(2), e.clickCount,
      c !== null ? c.toFixed(2) : '',
      day(e.createdAt), e.sourceUrl,
    ];
  });
  return [head, ...body].map((r) => r.map(csvField).join(',')).join('\r\n');
}

function exportCsv() {
  // BOM so Excel renders the em-dashes and curly quotes in these listings correctly.
  const blob = new Blob(['\ufeff' + toCsv()], { type: 'text/csv;charset=utf-8' });
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

  const cpcVal = calcCpc(e);
  const cpcClass = cpcVal !== null && cpcVal < 0.10 ? ' cpc-good' : '';

  return `<tr data-id="${esc(e.id)}">
    <td class="num rank">${rank}</td>
    <td><span class="listing">${avatar}<span>
      ${label}${badge}
      <span class="listing-desc">${esc(e.description)}</span>
    </span></span></td>
    <td class="col-cat"><span class="cat">${esc(catName.get(e.categorySlug) || e.categorySlug)}</span></td>
    <td class="num paid">${usd.format(e.amountCents / 100)}</td>
    <td class="num">${num.format(e.clickCount)}</td>
    <td class="num cpc col-cpc${cpcClass}">${formatCpc(e)}</td>
    <td class="date col-date">${day(e.createdAt)}</td>
  </tr>`;
}

/* ---------- search ----------
 * A listing is matched against four fields, and the needle is always a plain
 * substring: it comes from a text box, so it is not a pattern and must never be
 * compiled as one. Folding the four fields into one lowercased haystack per
 * listing, once at load, turns each keystroke into a single scan instead of four
 * coercions plus a four-element array allocated per listing per keystroke.
 *
 * '\n' cannot occur in the needle — a single-line input strips it — so joining
 * on it cannot let a query span the gap between two fields. */
const SEARCH_FIELDS = ['displayName', 'description', 'sourceUrl', 'identityKey'];

function buildSearchIndex(rows) {
  for (const e of rows) {
    e.haystack = SEARCH_FIELDS.map((f) => String(e[f] ?? '')).join('\n').toLowerCase();
  }
}

const matches = (e, needle) => e.haystack.includes(needle);

/* Spend tiers are one ladder, written out once here. The filter test and the summary
 * tiles both read it, so the filter and the numbers it is derived from cannot
 * drift apart. */
const TIERS = [['whale', 100000], ['high', 25000], ['mid', 5000], ['low', 0]];

function tierOf(e) {
  const cents = e.amountCents;
  for (let i = 0; i < TIERS.length - 1; i++) {
    if (cents >= TIERS[i][1]) return TIERS[i][0];
  }
  return TIERS[TIERS.length - 1][0];
}

/* Every number the panel shows comes off one walk of the filtered slice: category
 * totals, tier totals, and the grand total the tier shares divide by. Three
 * separate passes meant three allocations and three re-reads of the same array. */
function aggregate(rows) {
  const byCat = new Map();
  const tiers = new Map(TIERS.map(([t]) => [t, { n: 0, cents: 0 }]));
  let grand = 0;
  for (const e of rows) {
    const cents = e.amountCents;
    grand += cents;
    byCat.set(e.categorySlug, (byCat.get(e.categorySlug) || 0) + cents);
    const bucket = tiers.get(tierOf(e));
    bucket.n += 1;
    bucket.cents += cents;
  }
  return { grand, byCat, tiers };
}

/* Category spend panel. One series, so every bar wears the same hue — coloring
 * bars darker-where-bigger would double-encode length as color and burn the one
 * free channel on information the bar already shows. Bars scale to the largest
 * category in the slice, so the panel is self-normalising under any filter. */
function renderCats({ byCat, grand }) {
  const list = [...byCat].sort((a, b) => b[1] - a[1]);
  const max = list.length ? list[0][1] : 0;

  el('cat-rows').innerHTML = list
    .map(([slug, cents]) => {
      const name = catName.get(slug) || slug;
      return `<tr>
        <td class="cat-name">${esc(name)}</td>
        <td class="cat-bar-col"><span class="cat-bar" style="width:${(cents / max) * 100}%"></span></td>
        <td class="num">${usd.format(cents / 100)}</td>
      </tr>`;
    })
    .join('');

  el('panel-note').textContent = `${list.length} categor${list.length === 1 ? 'y' : 'ies'} · ${usd.format(grand / 100)} in this view`;
}

function renderTierSummary({ tiers, grand }) {
  // grand is 0 when nothing matches; the fallback keeps the share off NaN.
  const denom = grand || 1;
  for (const [t, v] of TIERS) {
    const valEl = el(`tier-val-${t}`);
    const metaEl = el(`tier-meta-${t}`);
    if (valEl) valEl.textContent = usd.format(v.cents / 100);
    if (metaEl) metaEl.textContent = `${num.format(v.n)} listings · ${((v.cents / denom) * 100).toFixed(1)}%`;
  }
}

function openDetail(e, syncState = true) {
  if (!e) return;
  activeModalId = e.id;
  const modal = el('detail-modal');
  el('modal-title').textContent = e.displayName;
  el('modal-desc').textContent = e.description || 'No description provided.';

  const src = safeImage(e.imageUrl);
  const letter = (e.displayName || '?').trim().charAt(0);
  el('modal-avatar-slot').innerHTML = src
    ? `<img class="avatar" src="${esc(src)}" alt="" width="44" height="44" onerror="this.remove();this.nextElementSibling.hidden=false"><span class="avatar avatar-fallback" hidden>${esc(letter)}</span>`
    : `<span class="avatar avatar-fallback">${esc(letter)}</span>`;

  const catLabel = catName.get(e.categorySlug) || e.categorySlug;
  el('modal-badges').innerHTML =
    `<span class="cat">${esc(catLabel)}</span>` +
    (e.identityType === 'x' ? '<span class="x-badge">X profile</span>' : '<span class="x-badge">Website</span>');

  const oRank = overallRankOf.get(e.id) || '—';
  const cRank = categoryRankOf.get(e.id) || '—';
  const cTotal = catCounts.get(e.categorySlug) || 50;

  el('modal-rank-overall').textContent = `#${oRank} of ${num.format(entries.length)}`;
  el('modal-rank-cat').textContent = `#${cRank} of ${cTotal} in ${catLabel}`;
  el('modal-paid').textContent = usd.format(e.amountCents / 100);
  el('modal-clicks').textContent = num.format(e.clickCount);
  el('modal-cpc').textContent = formatCpc(e) + (calcCpc(e) !== null ? ' / click' : '');
  el('modal-date').textContent = new Date(e.createdAt).toUTCString().replace('GMT', 'UTC');
  el('modal-identity').textContent = e.identityKey;

  const link = el('modal-link');
  const href = safeLink(e.sourceUrl);
  if (href) {
    link.href = href;
    link.hidden = false;
  } else {
    link.hidden = true;
  }

  el('modal-filter-cat').onclick = () => {
    el('category').value = e.categorySlug;
    closeModal();
    render();
  };

  el('modal-copy-status').textContent = '';
  if (!modal.open) modal.showModal();
  if (syncState) writeState();
}

function closeModal(syncState = true) {
  const modal = el('detail-modal');
  if (modal.open) modal.close();
  activeModalId = null;
  if (syncState) writeState();
}

function render() {
  const needle = el('q').value.trim().toLowerCase();
  const cat = el('category').value;
  const tier = el('tier').value;
  const platform = el('platform').value;
  const sorter = SORTS[el('sort').value] || bySpend;

  // Rank reflects position on the board being viewed (all-time, or one category),
  // so it stays stable while the search box narrows the rows. Both boards were
  // already built by computeRanks() at load; rebuilding them per keystroke was
  // re-deriving a value no search term can change.
  rankOf = cat ? categoryRankOf : overallRankOf;
  const board = cat ? categoryBoard(cat) : entries;

  shown = board.filter((e) =>
    (!needle || matches(e, needle)) &&
    (!tier || tierOf(e) === tier) &&
    (!platform || e.identityType === platform));
  shown.sort(sorter);

  el('rows').innerHTML = shown.map((e) => row(e, rankOf.get(e.id))).join('');

  const agg = aggregate(shown);
  el('result-count').textContent =
    `${num.format(shown.length)} of ${num.format(entries.length)} listings · ${usd.format(agg.grand / 100)} paid`;
  el('empty').hidden = shown.length > 0;

  renderCats(agg);
  renderTierSummary(agg);
  writeState();
}

function stats() {
  const dates = entries.map((e) => e.createdAt).sort();
  el('stat-count').textContent = num.format(entries.length);
  const totalPaid = entries.reduce((a, e) => a + e.amountCents, 0);
  const totalClicks = entries.reduce((a, e) => a + e.clickCount, 0);
  el('stat-spend').textContent = usd.format(totalPaid / 100);
  el('stat-clicks').textContent = num.format(totalClicks);
  if (el('stat-cpc')) {
    el('stat-cpc').textContent = totalClicks > 0 ? '$' + ((totalPaid / totalClicks) / 100).toFixed(2) : '—';
  }
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

function initTheme() {
  const saved = localStorage.getItem('outbid-theme') || 'auto';
  setTheme(saved);
  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      setTheme(btn.dataset.themeSet);
    });
  });
}

function setTheme(theme) {
  if (theme === 'auto') {
    document.documentElement.removeAttribute('data-theme');
    localStorage.removeItem('outbid-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('outbid-theme', theme);
  }
  document.querySelectorAll('.theme-btn').forEach((b) => {
    const active = b.dataset.themeSet === theme;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
}

function init() {
  initTheme();

  const [e, c] = [
    fetch(DATA + 'entries.json').then((r) => r.json()),
    fetch(DATA + 'categories.json').then((r) => r.json()),
  ];
  return Promise.all([e, c]).then(([entriesJson, categoriesJson]) => {
    entries = entriesJson;
    categories = categoriesJson;
    catName = new Map(categories.map((x) => [x.slug, x.name]));

    buildSearchIndex(entries);
    computeRanks();
    stats();
    populateCategories();
    readState();
    render();

    el('q').addEventListener('input', render);
    el('category').addEventListener('change', render);
    el('tier').addEventListener('change', render);
    el('platform').addEventListener('change', render);
    el('sort').addEventListener('change', render);
    el('export').addEventListener('click', exportCsv);

    // Row click opens detail modal
    el('rows').addEventListener('click', (evt) => {
      if (evt.target.closest('a')) return;
      const tr = evt.target.closest('tr[data-id]');
      if (!tr) return;
      const item = entries.find((x) => x.id === tr.dataset.id);
      if (item) openDetail(item);
    });

    // Modal dialog controls
    el('modal-close').addEventListener('click', () => closeModal());
    el('detail-modal').addEventListener('click', (evt) => {
      if (!evt.target.closest('.modal-card')) closeModal();
    });

    // Copy share link
    el('modal-copy-link').addEventListener('click', async () => {
      if (!activeModalId) return;
      const url = new URL(location.href);
      url.hash = `item=${activeModalId}`;
      try {
        await navigator.clipboard.writeText(url.toString());
        el('modal-copy-status').textContent = 'Link copied!';
        setTimeout(() => { if (el('modal-copy-status')) el('modal-copy-status').textContent = ''; }, 2500);
      } catch {
        el('modal-copy-status').textContent = 'Copy failed';
      }
    });

    // Tier summary tile click
    document.querySelectorAll('.tier-tile').forEach((tile) => {
      const handler = () => {
        const filter = tile.dataset.tierFilter;
        el('tier').value = el('tier').value === filter ? '' : filter;
        render();
      };
      tile.addEventListener('click', handler);
      tile.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault();
          handler();
        }
      });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (evt) => {
      if (evt.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
        evt.preventDefault();
        el('q').focus();
        el('q').select();
      } else if (evt.key === 'Escape') {
        const modal = el('detail-modal');
        if (modal.open) {
          closeModal();
        } else if (document.activeElement === el('q') && el('q').value) {
          el('q').value = '';
          render();
        }
      }
    });

    // Back/forward between shared views. render() uses replaceState, so it will not
    // re-trigger this; only genuine hash navigation arrives here.
    addEventListener('hashchange', () => { readState(); render(); });
  });
}

init().catch((err) => {
  el('result-count').textContent = 'Could not load data: ' + err.message;
});
