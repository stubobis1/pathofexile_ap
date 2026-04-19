// gem-tooltip.js
// Fetches gem data from poewiki.net via corsproxy.io (poewiki doesn't enable CORS).
// Renders a tooltip using the exact HTML structure and CSS from poewiki.net.
// Caches data in localStorage with a 2-week TTL.

const WIKI_API    = 'https://www.poewiki.net/api.php';
const CORS_PROXIES = [
  'https://corsproxy.io/?',
  'https://api.allorigins.win/raw?url=',
  'https://corsproxy.io/?',  // retry corsproxy on second pass
];
const BATCH_SIZE  = 10;
const BATCH_DELAY = 600; // ms between batches to avoid proxy rate-limiting
const HEADER_IMG = 'https://www.poewiki.net/w/images/9/9b/Item-ui-header-single.png';
const SEP_IMG    = 'https://www.poewiki.net/w/images/e/ef/Item-ui-separators.png';

const LS_PREFIX  = 'gem_wiki_';
const TTL_MS     = 14 * 24 * 60 * 60 * 1000; // 2 weeks

// L1: in-memory (session), L2: localStorage (persistent, TTL)
const _memCache   = new Map();  // name → data
const _inflight   = new Map();  // name → Promise (single-fetch)
const _preloading = new Set();  // names currently in a batch preload
let _tip    = null;
let _active = null;

// ── localStorage helpers ──────────────────────────────────────────────────────
function lsGet(name) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + name);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > TTL_MS) {
      localStorage.removeItem(LS_PREFIX + name);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function lsSet(name, data) {
  try {
    localStorage.setItem(LS_PREFIX + name, JSON.stringify({ data, ts: Date.now() }));
  } catch {
    // Quota exceeded — silently skip; in-memory cache still works
  }
}

export function clearCache() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith(LS_PREFIX));
  keys.forEach(k => localStorage.removeItem(k));
  _memCache.clear();
  console.log(`%c[GemTooltip] Cleared ${keys.length} cached gems.`, 'color:#70e8c8');
}

function logCacheStats() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith(LS_PREFIX));
  let valid = 0, expired = 0;
  for (const k of keys) {
    try {
      const { ts } = JSON.parse(localStorage.getItem(k) ?? '{}');
      Date.now() - ts <= TTL_MS ? valid++ : expired++;
    } catch { /* skip corrupt entries */ }
  }
  const parts = [`${valid} gem${valid !== 1 ? 's' : ''} cached`];
  if (expired) parts.push(`${expired} expired`);
  console.log(
    `%c[GemTooltip] ${parts.join(', ')}. To clear: %cgemTooltip.clearCache()`,
    'color:#c8b99a', 'color:#70e8c8; font-weight:bold'
  );
}

// ── CSS — exact values taken from poewiki.net site.styles ────────────────────
// Colors from wiki :root CSS vars:
//   --poe-color-gem          rgb(27,162,155)
//   --poe-color-default      rgb(127,127,127)
//   --poe-color-valuedefault rgb(255,255,255)
//   --poe-color-augmented    rgb(136,136,255)  → .tc.-mod
// Header sprite:    /w/images/9/9b/Item-ui-header-single.png
//   gem bg-pos: left -306px / right -374px / center -340px
// Separator sprite: /w/images/e/ef/Item-ui-separators.png
//   gem bg-pos: center -15px (3px tall strip, applied via ::after on each group except last)
const CSS = `
#gem-tip {
  position: fixed;
  z-index: 99999;
  pointer-events: none;
  display: none;
}
#gem-tip .item-box {
  display: inline-block;
  box-sizing: border-box;
  border-width: 1px;
  border-style: solid;
  padding: 2px;
  min-width: 220px;
  max-width: 420px;
  text-align: center;
  font-family: 'Fontin SmallCaps','Fontin',FontinSmallCaps,Verdana,Arial,Helvetica,sans-serif;
  font-size: 15px;
  line-height: 1.265;
  font-weight: normal;
  font-style: normal;
  font-variant-ligatures: none;
  color: rgb(127,127,127);
  background-color: #000;
  box-shadow: 0 6px 28px rgba(0,0,0,.92);
}
#gem-tip .item-box.-gem { border-color: rgb(27,162,155); }
#gem-tip .item-box > .header {
  display: block;
  overflow: hidden;
  position: relative;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 20px;
  background-repeat: no-repeat, no-repeat, repeat-x;
}
#gem-tip .item-box.-gem > .header { color: rgb(27,162,155); }
#gem-tip .item-box > .header.-single {
  background-image: url("${HEADER_IMG}"),url("${HEADER_IMG}"),url("${HEADER_IMG}");
  padding: 3px 32px;
  height: 28px;
  line-height: 25px;
}
#gem-tip .item-box.-gem > .header.-single {
  background-position: left -306px, right -374px, center -340px;
}
#gem-tip .item-box > .header > .symbol {
  content: "";
  display: block;
  position: absolute;
  top: 0;
  background-position: center;
  background-repeat: no-repeat;
}
#gem-tip .item-box > .header > .symbol:first-child { left: 0; }
#gem-tip .item-box > .header > .symbol:last-child  { right: 0; }
#gem-tip .item-box > .header.-single > .symbol { width: 32px; height: 34px; }
#gem-tip .item-stats { display: block; padding: 7px 12px; margin: 0 auto; }
#gem-tip .item-stats > .group { display: block; margin: 0 auto; }
#gem-tip .item-stats > .group:nth-last-child(n+2)::after {
  display: block;
  margin: 5px auto;
  width: auto;
  height: 3px;
  background-image: url("${SEP_IMG}");
  background-position: center -15px;
  background-repeat: no-repeat;
  content: "";
}
#gem-tip .tc      { font-style: normal; }
#gem-tip em.tc    { font-style: normal; }
#gem-tip em.tc.-i { font-style: italic; }
#gem-tip .tc.-value { color: rgb(255,255,255); }
#gem-tip .tc.-mod {
  font-family: 'Fontin SmallCaps','Fontin',FontinSmallCaps,Verdana,Arial,Helvetica,sans-serif;
  font-variant-ligatures: none;
  color: rgb(136,136,255);
}
#gem-tip .tc.-gemdesc  { color: rgb(27,162,155); }
#gem-tip .tc.-help     { font-style: italic; color: rgb(127,127,127); }
#gem-tip .tc.-corrupted{ color: rgb(210,0,0); }
#gem-tip .gt-spin,
#gem-tip .gt-err {
  min-width: 220px;
  padding: 14px 16px;
  text-align: center;
  font-family: 'Fontin SmallCaps','Fontin',Verdana,Arial,sans-serif;
  font-size: 13px;
  background: #000;
  border: 1px solid rgb(27,162,155);
  box-shadow: 0 6px 28px rgba(0,0,0,.92);
}
#gem-tip .gt-spin { color: rgb(127,127,127); font-style: italic; }
#gem-tip .gt-err  { color: rgb(200,80,80); }
[data-gem] { cursor: default; }
`;

function injectStyle() {
  if (document.getElementById('gem-tip-css')) return;
  const s = document.createElement('style');
  s.id = 'gem-tip-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

function createTip() {
  const el = document.createElement('div');
  el.id = 'gem-tip';
  document.body.appendChild(el);
  return el;
}

// ── Wiki data fetching ────────────────────────────────────────────────────────
async function proxiedFetch(wikiUrl) {
  for (const proxy of CORS_PROXIES) {
    try {
      const r = await fetch(proxy + encodeURIComponent(wikiUrl));
      if (r.ok) return r;
    } catch {}
  }
  throw new Error('All proxies failed');
}

async function fetchWikitext(title) {
  const params = new URLSearchParams({
    action: 'query', prop: 'revisions', titles: title,
    rvslots: 'main', rvprop: 'content', format: 'json', redirects: '1',
  });
  const r = await proxiedFetch(`${WIKI_API}?${params}`);
  const j = await r.json();
  const pages = j?.query?.pages;
  if (!pages) return null;
  const page = Object.values(pages)[0];
  if (page.missing !== undefined) return null;
  return page?.revisions?.[0]?.slots?.main?.['*'] ?? null;
}

// Fetch up to BATCH_SIZE titles in one request; returns Map<title, wikitext>
async function fetchWikitextBatch(titles) {
  const params = new URLSearchParams({
    action: 'query', prop: 'revisions',
    titles: titles.join('|'),
    rvslots: 'main', rvprop: 'content', format: 'json',
    redirects: '1',
  });
  const r = await proxiedFetch(`${WIKI_API}?${params}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const out = new Map();
  for (const page of Object.values(j?.query?.pages ?? {})) {
    const wt = page?.revisions?.[0]?.slots?.main?.['*'] ?? null;
    if (wt && page.missing === undefined) out.set(page.title, wt);
  }
  return out;
}

// Parse |key = value lines; first occurrence wins (handles |stat_text=1 dedup markers)
function parseFields(wikitext) {
  const data = {};
  for (const line of wikitext.split('\n')) {
    const m = line.match(/^\|\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in data)) data[m[1]] = m[2];
  }
  return data;
}

async function loadGemFromWiki(name) {
  for (const title of [name, `${name} (gem)`]) {
    const wt = await fetchWikitext(title);
    if (wt && wt.trimStart().startsWith('{{Item')) {
      return { fields: parseFields(wt) };
    }
  }
  return { notFound: true };
}

function fetchGem(name) {
  if (_memCache.has(name)) return Promise.resolve(_memCache.get(name));
  if (_inflight.has(name)) return _inflight.get(name);

  const p = (async () => {
    // L2: localStorage
    const stored = lsGet(name);
    if (stored) {
      _memCache.set(name, stored);
      return stored;
    }
    // Fetch from wiki
    const data = await loadGemFromWiki(name);
    _memCache.set(name, data);
    lsSet(name, data);
    return data;
  })().catch(() => {
    const data = { error: true };
    _memCache.set(name, data);
    return data;
  }).finally(() => {
    _inflight.delete(name);
  });

  _inflight.set(name, p);
  return p;
}

// ── Preload — batched (up to BATCH_SIZE titles per request) ──────────────────
export async function preloadGems(names) {
  const toFetch = names.filter(n => {
    if (_memCache.has(n) || _preloading.has(n)) return false;
    const stored = lsGet(n);
    if (stored !== null) { _memCache.set(n, stored); return false; }
    return true;
  });
  if (!toFetch.length) return;

  toFetch.forEach(n => _preloading.add(n));

  function store(name, data) {
    _memCache.set(name, data);
    _preloading.delete(name);
    lsSet(name, data);
  }

  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    if (i > 0) await new Promise(r => setTimeout(r, BATCH_DELAY));
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    let results;
    try {
      results = await fetchWikitextBatch(batch);
    } catch (e) {
      console.warn('[GemTooltip] Batch preload failed:', e);
      batch.forEach(n => { _preloading.delete(n); });
      continue;
    }

    const needDisambig = [];
    for (const name of batch) {
      const wt = results.get(name);
      if (wt && wt.trimStart().startsWith('{{Item')) {
        store(name, { fields: parseFields(wt) });
      } else {
        needDisambig.push(name);
      }
    }

    if (!needDisambig.length) continue;
    let dis;
    try {
      dis = await fetchWikitextBatch(needDisambig.map(n => `${n} (gem)`));
    } catch (e) {
      console.warn('[GemTooltip] Disambig batch failed:', e);
      needDisambig.forEach(n => store(n, { notFound: true }));
      continue;
    }
    for (const name of needDisambig) {
      const wt = dis.get(`${name} (gem)`);
      store(name, wt && wt.trimStart().startsWith('{{Item')
        ? { fields: parseFields(wt) }
        : { notFound: true });
    }
  }
}

// ── HTML builder — mirrors the wiki's exact item-box markup ──────────────────
function v(text) { return `<em class="tc -value">${text}</em>`; }

function reqRange(lo, hi) {
  if (!lo || lo === '0') return null;
  return (!hi || hi === lo) ? lo : `(${lo}-${hi})`;
}

function buildHTML(name, data) {
  if (data.notFound) {
    return `<div class="gt-err">No wiki page found for "<strong>${name}</strong>".</div>`;
  }
  if (data.error) {
    return `<div class="gt-err">Could not reach poewiki.net — check your connection.</div>`;
  }

  const f = data.fields;

  const tags     = f.gem_tags         || '';
  const desc     = f.gem_description  || '';
  const helpTxt  = f.help_text        || 'Place into an item socket of the right colour to gain this skill. Right click to remove from a socket.';
  const statTxt  = f.stat_text        || '';
  const qualTxt  = f.quality_type1_stat_text || '';
  const isSupport = tags.toLowerCase().includes('support');

  const rawCast = parseFloat(f.cast_time ?? '0');
  const castT   = (!isNaN(rawCast) && rawCast > 0) ? rawCast.toFixed(2) : null;
  const crit    = f.static_critical_strike_chance
    ? parseFloat(f.static_critical_strike_chance).toFixed(2) : null;
  const dmgEff  = f.static_damage_effectiveness || null;

  const resPct      = f.static_mana_reservation_percent    || null;
  const resFlat     = f.static_mana_reservation_flat       || null;
  const costTypes   = f.static_cost_types || 'Mana';
  const cost1       = f.level1_cost_amounts  || null;
  const cost20      = f.level20_cost_amounts || null;
  const costStr     = (cost1 && cost20 && cost1 !== cost20) ? `(${cost1}-${cost20})` : (cost1 || cost20 || null);
  const costResMult = f.static_cost_and_reservation_multiplier
    || f.static_cost_multiplier || null;
  const supportLetter = f.support_gem_letter || null;

  const reqLvl1   = f.required_level || f.level1_level_requirement || null;
  const reqLvl20  = f.level20_level_requirement || null;
  const reqLvlStr = reqRange(reqLvl1, reqLvl20);

  const intPct = parseInt(f.intelligence_percent || '0', 10);
  const strPct = parseInt(f.strength_percent     || '0', 10);
  const dexPct = parseInt(f.dexterity_percent    || '0', 10);
  const intStr = intPct ? reqRange(f.level1_intelligence_requirement, f.level20_intelligence_requirement) : null;
  const strStr = strPct ? reqRange(f.level1_strength_requirement,     f.level20_strength_requirement)     : null;
  const dexStr = dexPct ? reqRange(f.level1_dexterity_requirement,    f.level20_dexterity_requirement)    : null;

  // First group: tags + key stats
  const g1Parts = [tags];
  if (isSupport && supportLetter) {
    const cls = intPct > strPct && intPct > dexPct ? 'blue' : strPct > dexPct ? 'red' : 'green';
    g1Parts.push(`Icon: <span class="support-gem-id-${cls}">${supportLetter}</span>`);
  }
  g1Parts.push(`Level: ${v('(1-20)')}`);
  if (resPct)       g1Parts.push(`Reservation: ${v(`${resPct}% ${costTypes}`)}`);
  else if (resFlat) g1Parts.push(`Reservation: ${v(`${resFlat} ${costTypes}`)}`);
  else if (costResMult) g1Parts.push(`Cost &amp; Reservation Multiplier: ${v(`${costResMult}%`)}`);
  else if (costStr) g1Parts.push(`Cost: ${v(`${costStr} ${costTypes}`)}`);
  if (castT)  g1Parts.push(`Cast Time: ${v(`${castT} sec`)}`);
  if (crit)   g1Parts.push(`Critical Strike Chance: ${v(`${crit}%`)}`);
  if (dmgEff) g1Parts.push(`Effectiveness of Added Damage: ${v(`${dmgEff}%`)}`);

  // Requirements group
  const reqParts = [];
  if (reqLvlStr)        reqParts.push(`Level ${v(reqLvlStr)}`);
  if (intStr && intPct) reqParts.push(`Int ${v(intStr)}`);
  if (strStr && strPct) reqParts.push(`Str ${v(strStr)}`);
  if (dexStr && dexPct) reqParts.push(`Dex ${v(dexStr)}`);

  // Mod group: stat text + quality
  const modParts = [];
  if (statTxt) modParts.push(statTxt.replace(/<br\s*\/?>/gi, '<br>'));
  if (qualTxt) modParts.push(` <br> ${v(`Additional Effects From 1-20% Quality:<br><em class="tc -mod">${qualTxt}</em>`)}`);

  const groups = [];
  groups.push(`<span class="group">${g1Parts.join('<br>')}</span>`);
  if (reqParts.length) groups.push(`<span class="group">Requires ${reqParts.join(', ')}</span>`);
  if (desc)            groups.push(`<span class="group tc -gemdesc">${desc}</span>`);
  if (modParts.length) groups.push(`<span class="group tc -mod">${modParts.join('')}</span>`);
  groups.push(`<span class="group tc -help">${helpTxt}</span>`);

  return `<span class="item-box -gem">
    <span class="header -single"><span class="symbol"></span>${name}<span class="symbol"></span></span>
    <span class="item-stats">${groups.join('')}</span>
  </span>`;
}

// ── Position / show / hide ────────────────────────────────────────────────────
function pos(x, y) {
  const W  = window.innerWidth;
  const H  = window.innerHeight;
  const tw = (_tip.firstElementChild?.offsetWidth  || 420) + 20;
  const th = (_tip.firstElementChild?.offsetHeight || 200) + 20;
  _tip.style.left = Math.max(4, x + tw > W ? x - tw : x + 14) + 'px';
  _tip.style.top  = Math.max(4, y + th > H ? y - th : y + 14) + 'px';
}

async function show(e, name) {
  _active = name;
  _tip.innerHTML = `<div class="gt-spin">${name}…</div>`;
  _tip.style.display = 'block';
  pos(e.clientX, e.clientY);
  const data = await fetchGem(name);
  if (_active !== name) return;
  _tip.innerHTML = buildHTML(name, data);
  _tip.style.display = 'block';
  pos(e.clientX, e.clientY);
}

function hide() { _active = null; if (_tip) _tip.style.display = 'none'; }
function move(e) { if (_tip?.style.display !== 'none') pos(e.clientX, e.clientY); }

// ── Attachment ────────────────────────────────────────────────────────────────
function attach(el) {
  if (el._gtAttached) return;
  el._gtAttached = true;
  const name = el.dataset.gem;
  el.addEventListener('mouseenter', e => show(e, name));
  el.addEventListener('mousemove',  move);
  el.addEventListener('mouseleave', hide);
}

export function initGemTooltips() {
  injectStyle();
  _tip = createTip();
  document.querySelectorAll('[data-gem]').forEach(attach);

  // Pick up gem tags rendered dynamically after AP connection
  new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.dataset?.gem) attach(n);
      n.querySelectorAll?.('[data-gem]').forEach(attach);
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Expose cache control globally and log stats
  window.gemTooltip = { clearCache };
  logCacheStats();
}
