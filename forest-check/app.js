// Free EUDR forest check — page logic. The analysis itself runs in worker.js; file reading in readers.js.
import { readFile, toPlots, UserError, MAX_PLOT_HA } from './readers.js';
import { t, num, LANG } from './i18n.js';
import { CONFIG } from './config.js';
const asset = (f) => new URL(f, import.meta.url).href;   // works from /forest-check/, /es/forest-check/, /pt/forest-check/

// JRC GFC2020 v4, 10° COG tiles on Cloudflare R2 (see eudr project, tools/build_tiles.py)
const SOURCE = { type: 'tiles', manifest: CONFIG.TILES_MANIFEST };
const WMS = 'https://ies-ows.jrc.ec.europa.eu/iforce/gfc2020/wms.py?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap'
  + '&LAYERS=gfc2020_v4&STYLES=&FORMAT=image/png&TRANSPARENT=true&CRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}';

// Mapbox account without a card: hard stop at 20,000 tiles/month, never billed. When it refuses,
// the free Sentinel-2 mosaic underneath shows through. ?mbtoken=x simulates a refused token.
const MAPBOX_TOKEN = new URLSearchParams(location.search).get('mbtoken') ?? CONFIG.MAPBOX_TOKEN;
const PAID_MINZOOM = 11;   // Mapbox tiles only at field scale (4–8 tiles per view)

const STATUS = Object.fromEntries(['forest', 'clear', 'outside', 'notCovered', 'noTile', 'tooSmall', 'sea', 'tooLarge', 'skipped']
  .map((k) => [k, t('st_' + k)]));   // internal code -> label shown to the user
const MAX_TOTAL_HA = 5e6;  // whole file; beyond this the browser would download hundreds of MB of map data

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const step = (n) => { document.body.dataset.step = n; };
step(1);
const say = (text, err = false) => { $('log').textContent = text; $('log').classList.toggle('err', err); };
let last = null;   // { rows, features }

// ---------------------------------------------------------------- map
const BASEMAPS = {};
if (MAPBOX_TOKEN) BASEMAPS.today = { label: t('bm_sat'), tileSize: 512, maxzoom: 19,
           attribution: '<a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener">© Mapbox</a> © Maxar '
             + '<a href="https://www.mapbox.com/map-feedback/" target="_blank" rel="noopener">Improve this map</a>',
           tiles: `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/512/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}` };
BASEMAPS.s2 = { label: t('bm_s2'), tileSize: 256, maxzoom: 15,
        attribution: '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless 2016 by EOX</a> (modified Copernicus data)',
        tiles: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg' };
const shown = (layer, mode) => layer === mode || (layer === 's2' && mode !== 's2');   // Sentinel-2 always underneath

class BasemapSwitch {
  constructor(start) { this.current = start; }
  onAdd(m) {
    this._m = m;
    this._el = document.createElement('div');
    this._el.className = 'maplibregl-ctrl maplibregl-ctrl-group basemap-switch';
    for (const k of Object.keys(BASEMAPS)) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = BASEMAPS[k].label; b.dataset.k = k;
      b.setAttribute('aria-pressed', String(k === this.current));
      b.classList.toggle('on', k === this.current);
      b.onclick = () => this.set(k);
      this._el.appendChild(b);
    }
    return this._el;
  }
  set(k) {
    const m = this._m;
    // Only the style must be parsed; isStyleLoaded() and 'load' also wait for tiles, which may never finish.
    if (!m.style?._loaded) { m.once('style.load', () => this.set(k)); return; }
    for (const key of Object.keys(BASEMAPS)) m.setLayoutProperty('bm_' + key, 'visibility', shown(key, k) ? 'visible' : 'none');
    this.current = k;
    this._el.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.k === k); b.setAttribute('aria-pressed', String(b.dataset.k === k));
    });
  }
  onRemove() { this._el.remove(); }
}

class MapboxLogo {   // required by the Mapbox terms when showing Mapbox tiles
  onAdd() {
    const a = document.createElement('a');
    a.className = 'maplibregl-ctrl'; a.href = 'https://www.mapbox.com/'; a.target = '_blank'; a.rel = 'noopener';
    a.setAttribute('aria-label', 'Mapbox');
    a.innerHTML = `<img class="fc-mapbox-logo" src="${asset('mapbox-logo.svg')}" alt="Mapbox" width="88" height="20">`;
    return (this._el = a);
  }
  onRemove() { this._el.remove(); }
}

let map = null;
try {
  const start = BASEMAPS.today ? 'today' : 's2';
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        ...Object.fromEntries(Object.entries(BASEMAPS).map(([k, b]) => ['bm_' + k,
          { type: 'raster', tiles: [b.tiles], tileSize: b.tileSize, maxzoom: b.maxzoom, attribution: b.attribution }])),
        gfc: { type: 'raster', tileSize: 256, tiles: [WMS], attribution: 'Forest 2020: © EU, JRC GFC2020 v4' },
      },
      layers: [
        { id: 'bm_s2', type: 'raster', source: 'bm_s2', layout: { visibility: 'visible' } },
        ...(BASEMAPS.today ? [{ id: 'bm_today', type: 'raster', source: 'bm_today', minzoom: PAID_MINZOOM, layout: { visibility: shown('today', start) ? 'visible' : 'none' } }] : []),
        { id: 'gfc', type: 'raster', source: 'gfc', paint: { 'raster-opacity': 0.5 } },
      ],
    },
    center: [-20, 0], zoom: 1.6,
    attributionControl: { compact: true },
    cooperativeGestures: matchMedia('(pointer: coarse)').matches,   // phones: two fingers to move the map
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
  const sw = new BasemapSwitch(start);
  if (Object.keys(BASEMAPS).length > 1) map.addControl(sw, 'top-left');   // no switch when only Sentinel-2 is available
  if (BASEMAPS.today) map.addControl(new MapboxLogo(), 'bottom-left');
  map.on('error', (e) => {
    if (sw.current === 'today' && e.sourceId === 'bm_today' && [401, 402, 403, 429].includes(e.error?.status)) {
      setTimeout(() => sw.set('s2'), 0);
    }
  });
} catch (e) {
  console.warn('Map unavailable', e);
  $('map').innerHTML = `<div class="fc-nomap">${esc(t('nomap'))}</div>`;
}
const mapReady = map ? new Promise((ok) => map.loaded() ? ok() : map.once('load', ok)) : null;

const COLOR = ['match', ['get', 'code'], 'forest', '#e2621b', 'clear', '#35c46b', '#b9c0bc'];
async function showOnMap(features) {
  if (!map) return;
  await mapReady;
  const data = { type: 'FeatureCollection', features };
  if (map.getSource('plots')) map.getSource('plots').setData(data);
  else {
    map.addSource('plots', { type: 'geojson', data });
    const notPoint = ['!=', ['geometry-type'], 'Point'];
    map.addLayer({ id: 'fill', type: 'fill', source: 'plots', filter: notPoint, paint: { 'fill-color': COLOR, 'fill-opacity': 0.22 } });
    map.addLayer({ id: 'line', type: 'line', source: 'plots', filter: notPoint, paint: { 'line-color': COLOR, 'line-width': 2.2 } });
    map.addLayer({ id: 'pt', type: 'circle', source: 'plots', filter: ['==', ['geometry-type'], 'Point'],
                   paint: { 'circle-color': COLOR, 'circle-radius': 6, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
    for (const l of ['fill', 'pt']) {
      map.on('click', l, (e) => popup(e.features[0].properties, e.lngLat));
      map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
    }
  }
  fitTo(features, 40);
}
function fitTo(features, padding) {
  const b = new maplibregl.LngLatBounds();
  const walk = (c) => { if (!Array.isArray(c)) return; typeof c[0] === 'number' ? b.extend([c[0], c[1]]) : c.forEach(walk); };
  const geom = (g) => g && (g.type === 'GeometryCollection' ? g.geometries.forEach(geom) : walk(g.coordinates));
  features.forEach((f) => geom(f.geometry));
  if (!b.isEmpty()) map.fitBounds(b, { padding, maxZoom: 15, duration: 600 });
}
function popup(p, lngLat) {
  const hasArea = p.forest_ha != null && p.forest_ha !== 'null';
  new maplibregl.Popup({ maxWidth: '260px' }).setLngLat(lngLat).setHTML(
    `<b>${esc(p.plot)}</b><br>${esc(p.result)}`
    + (hasArea ? `<br>${t('pp_forest')}: ${(+p.forest_ha).toFixed(2)} ha (${(+p.forest_pct).toFixed(1)}%)<br>${t('pp_area')}: ${(+p.area_ha).toFixed(2)} ha` : '')
    + (p.note ? `<br><span style="color:#b45309">⚠ ${esc(p.note)}</span>` : '')
  ).addTo(map);
}

// ---------------------------------------------------------------- analysis
function analyse(plots, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker(asset('worker.js'), { type: 'module' });
    w.onmessage = (e) => {
      if (e.data.type === 'progress') onProgress?.(e.data);
      else { w.terminate(); e.data.type === 'done' ? resolve(e.data) : reject(new Error(e.data.message)); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || t('worker_stopped'))); };
    w.postMessage({ source: SOURCE, opts: {}, plots: plots.map(({ feature, ...p }) => p) });
  });
}

function classify(r, thr) {
  if (r.outside) return 'outside';
  if (r.notCovered) return 'notCovered';
  if (r.missingTile && !r.forestPx && !r.forest) return 'noTile';
  if (r.kind === 'point') return r.forest ? 'forest' : 'clear';
  if (!r.px) return 'tooSmall';                     // no map pixel centre inside the polygon (under ~0.01 ha)
  return r.forestPx > 0 && r.forestHa >= thr ? 'forest' : 'clear';
}

let busy = false, lastWarnings = [];

// Sea check: plots without forest whose location is not on land (Natural Earth 1:10m land and minor islands, public domain,
// extended ~100 m beyond the coast). Catches swapped latitude/longitude and similar mistakes.
let land = null;
async function loadLand() {
  if (land) return land;
  const { rings, scale = 100 } = await (await fetch(asset('landmask.json'))).json();
  land = rings.map((r) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < r.length; i += 2) { const x = r[i] / scale, y = r[i + 1] / scale; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return { r, s: scale, x0, x1, y0, y1 };
  });
  return land;
}
function onLand(x, y) {
  let c = false;                                   // even-odd over all rings: lakes are holes
  for (const L of land) {
    if (x < L.x0 || x > L.x1 || y < L.y0 || y > L.y1) continue;
    const r = L.r, n = r.length, s = L.s;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const yi = r[i + 1] / s, yj = r[j + 1] / s;
      if ((yi > y) !== (yj > y) && x < (r[j] / s - r[i] / s) * (y - yi) / (yj - yi) + r[i] / s) c = !c;
    }
  }
  return c;
}
async function markSea(rows, plots) {
  const cand = rows.map((r, i) => [r, plots[i]]).filter(([r, p]) => p && (r.code === 'clear' || r.code === 'noTile'));
  if (!cand.length) return;
  try { await loadLand(); } catch { return; }      // the check is a bonus; never block results
  for (const [r, p] of cand) {
    let x, y;
    if (p.kind === 'point') { x = p.lon; y = p.lat; }
    else { const g = p.rings[0]; x = 0; y = 0; for (let k = 0; k < g.length; k += 2) { x += g[k]; y += g[k + 1]; } x /= g.length / 2; y /= g.length / 2; }
    const d = 0.01;                                 // ~1 km tolerance on top of the ~100 m margin
    if (![[0, 0], [d, 0], [-d, 0], [0, d], [0, -d]].some(([dx, dy]) => onLand(x + dx, y + dy))) {
      r.code = 'sea';
      r.note = [r.note, t('n_sea')].filter(Boolean).join('; ');
    }
  }
}
async function run(files) {
  if (busy || !files.length) return;
  busy = true;
  document.body.classList.add('fc-busy');
  step(2);
  try {
    if (!CONFIG.TILES_MANIFEST) throw new UserError('No forest map tiles are configured. Set TILES_MANIFEST in config.js (see README).');
    say(t('reading'));
    const all = [], warnings = [];
    for (const f of files) { const r = await readFile(f); all.push(...r.features); warnings.push(...r.warnings); }
    const { plots, skipped, outOfRange, checked } = toPlots(all);
    if (!all.length) throw new UserError(t('err_nofeatures'));
    if (checked && outOfRange / checked > 0.5)
      throw new UserError(t('err_metres'));
    if (!plots.length) throw new UserError(skipped.some((x) => x.code === 'tooLarge') ? t('err_alltoolarge', { max: num(MAX_PLOT_HA) }) : t('err_nousable'));
    const totalHa = plots.reduce((a, p) => a + (p.approxHa || 0), 0);
    if (totalHa > MAX_TOTAL_HA)
      throw new UserError(t('err_total', { mha: num(Math.round(totalHa / 1e6)), limit: num(MAX_TOTAL_HA / 1e6) }));
    if (outOfRange) warnings.push(t('warn_outofrange', { n: outOfRange }));
    say(t('checking', { n: num(plots.length) }));
    const t0 = performance.now();
    const out = await analyse(plots, (p) => say(t('progress', { pct: Math.round(100 * p.done / p.total) })));
    const thr = Number($('thr').value) || 0;
    const rows = out.results.map((r, i) => ({ ...r, code: classify(r, thr), feature: plots[i].feature,
                                               approx: plots[i].approx, holeOutside: plots[i].holeOutside, multi: plots[i].multi,
                                               note: plots[i].notes?.join('; ') || '' }));
    await markSea(rows, plots);
    for (const s of skipped) rows.push({ id: s.id, kind: '', code: s.code || 'skipped', note: s.reason, feature: s.feature });
    lastWarnings = warnings;
    render(rows);
    step(3);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    say(t('done', { n: num(plots.length), secs: num(secs) }));
  } catch (e) {
    console.error(e);
    say(e instanceof UserError ? e.message : t('err_generic', { detail: e.message }), true);
    step(last ? 3 : 1);
  } finally {
    busy = false;
    document.body.classList.remove('fc-busy');
  }
}

// ---------------------------------------------------------------- results
function render(rows) {
  const features = rows.filter((r) => r.feature?.geometry).map((r) => ({
    type: 'Feature', geometry: r.feature.geometry,
    properties: { ...r.feature.properties, plot: r.id, code: r.code, result: STATUS[r.code],
                  area_ha: r.totalHa ?? null, forest_ha: r.forestHa ?? null, forest_pct: r.forestPct ?? null,
                  ...(r.note ? { note: r.note } : {}) },
  }));
  last = { rows, features };
  drawIssues(rows);
  const n = (c) => rows.filter((r) => r.code === c).length;
  $('sTotal').textContent = rows.length;
  $('sForest').textContent = n('forest');
  $('sClear').textContent = n('clear') + n('noTile');
  $('sNa').textContent = rows.length - n('forest') - n('clear') - n('noTile');
  drawTable();
  $('dl').disabled = false;
  showOnMap(features);
}

// "Data check": what in the file could not be checked or needs a second look
function drawIssues(rows) {
  const n = (c) => rows.filter((r) => r.code === c).length;
  const items = [];
  const reasons = {};
  for (const r of rows) if (r.code === 'skipped') { const k = r.note.replace(/\s*\(.*$/, ''); reasons[k] = (reasons[k] || 0) + 1; }
  for (const [k, c] of Object.entries(reasons)) items.push(['warn', t('dc_notchecked', { n: c, reason: k })]);
  if (n('tooLarge')) items.push(['warn', t('dc_toolarge', { n: n('tooLarge'), max: num(MAX_PLOT_HA) })]);
  if (n('tooSmall')) items.push(['warn', t('dc_toosmall', { n: n('tooSmall') })]);
  const approx = rows.filter((r) => r.approx).length;
  if (approx) items.push(['warn', t('dc_approx', { n: approx })]);
  const holes = rows.filter((r) => r.holeOutside).length;
  if (holes) items.push(['info', t('dc_holes', { n: holes })]);
  if (n('notCovered')) items.push(['info', t('dc_notcovered', { n: n('notCovered') })]);
  if (n('outside')) items.push(['warn', t('dc_outside', { n: n('outside') })]);
  if (n('sea')) items.push(['warn', t('dc_sea', { n: n('sea') })]);
  const multi = rows.filter((r) => r.multi).length;
  if (multi) items.push(['info', t('dc_multi', { n: multi })]);
  const lost = n('outside') + n('sea'), checked = rows.length - n('skipped') - n('tooLarge');
  if (checked >= 3 && lost / checked >= 0.2) items.push(['warn', t('dc_swapped')]);
  for (const w of lastWarnings) items.push(['info', w]);
  const el = $('issues');
  el.hidden = false;
  el.innerHTML = items.length
    ? `<b>${esc(t('dc_title'))}</b><ul>${items.map(([k, x]) => `<li class="${k}">${esc(x)}</li>`).join('')}</ul>`
    : `<b>${esc(t('dc_title'))}</b> <span class="ok">${esc(t('dc_ok'))}</span>`;
}

let sortKey = 'forestHa', sortDir = -1;
const DOT = { forest: 'var(--fc-forest)', clear: 'var(--fc-clear)', noTile: 'var(--fc-clear)' };
function drawTable() {
  if (!last) return;
  const val = (r) => sortKey === 'status' ? STATUS[r.code] : r[sortKey];
  const sorted = [...last.rows].sort((a, b) => {
    const x = val(a) ?? -1, y = val(b) ?? -1;
    return (x > y ? 1 : x < y ? -1 : 0) * sortDir;
  });
  const f = (v, d) => v == null ? '' : v.toFixed(d);
  $('tbl').tBodies[0].innerHTML = sorted.map((r) => `<tr data-id="${esc(r.id)}" title="${esc(r.note || '')}">
    <td title="${esc(r.id)}">${esc(r.id)}</td><td class="n">${r.kind === 'point' ? t('point') : f(r.totalHa, 2)}</td>
    <td class="n">${r.kind === 'point' ? '' : f(r.forestHa, 2)}</td><td class="n">${r.kind === 'point' ? '' : f(r.forestPct, 1)}</td>
    <td><span class="dot" style="background:${DOT[r.code] || 'var(--fc-na)'}"></span>${esc(STATUS[r.code])}${r.note ? ' <span class="fc-flag" aria-label="' + esc(r.note) + '">⚠</span>' : ''}</td></tr>`).join('');
  document.querySelectorAll('#tbl th').forEach((th) => {
    if (th.dataset.k === sortKey) th.setAttribute('aria-sort', sortDir > 0 ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  });
}
document.querySelectorAll('#tbl th').forEach((th) => th.onclick = () => {
  const k = th.dataset.k; sortDir = sortKey === k ? -sortDir : (k === 'id' || k === 'status' ? 1 : -1); sortKey = k;
  drawTable();
});
$('tbl').tBodies[0].addEventListener('click', (e) => {   // click a row: zoom to that plot
  const id = e.target.closest('tr')?.dataset.id;
  const f = last?.features.find((x) => String(x.properties.plot) === id);
  if (f && map) { fitTo([f], 80); }
});
$('thr').addEventListener('change', () => {               // re-classify without re-reading the map
  if (!last) return;
  const thr = Number($('thr').value) || 0;
  render(last.rows.map((r) => ['skipped', 'tooLarge', 'sea'].includes(r.code) ? r : { ...r, code: classify(r, thr) }));
});

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function csvText() {
  const q = (v) => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
  const lines = ['plot_id,geometry,area_ha,forest_ha,forest_pct,forest_at_point,result'];
  for (const r of last.rows) lines.push([r.id, r.kind, r.totalHa?.toFixed(4), r.forestHa?.toFixed(4), r.forestPct?.toFixed(2),
    r.kind === 'point' ? (r.forest ? 1 : 0) : '', STATUS[r.code] + (r.note ? ` (${r.note})` : '')].map(q).join(','));
  lines.push('', t('csv_note'));
  return lines.join('\n');
}
async function downloadZip() {
  const { zipSync, strToU8 } = await import('https://cdn.jsdelivr.net/npm/fflate@0.8.2/+esm');
  const readme = t('readme');
  const zip = zipSync({
    'forest_check.csv': strToU8(csvText()),
    'forest_check.geojson': strToU8(JSON.stringify({ type: 'FeatureCollection', features: last.features })),
    'README.txt': strToU8(readme),
  });
  download('forest_check.zip', new Blob([zip], { type: 'application/zip' }));
}

// ---------------------------------------------------------------- registration before download
const FORMS_URL = CONFIG.FORMS_URL;                 // empty: download without registration
const TURNSTILE_SITEKEY = CONFIG.TURNSTILE_SITEKEY;   // optional Cloudflare Turnstile site key (spam protection)
const ERRORS = Object.fromEntries(['name', 'org', 'email', 'email_disposable', 'email_domain', 'consent', 'captcha']
  .map((k) => [k, t('reg_' + k)]));
const dlg = $('reg'), form = $('reg-form');
const saved = (() => { try { return JSON.parse(localStorage.getItem('fc-reg') || 'null'); } catch { return null; } })();
if (saved) { $('reg-name').value = saved.name || ''; $('reg-org').value = saved.org || ''; $('reg-email').value = saved.email || ''; }

let captchaToken = '';
async function setupCaptcha() {
  if (!TURNSTILE_SITEKEY || setupCaptcha.done) return;
  setupCaptcha.done = true;
  await new Promise((ok, fail) => { const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.onload = ok; s.onerror = fail; document.head.appendChild(s); });
  turnstile.render('#reg-captcha', { sitekey: TURNSTILE_SITEKEY, callback: (t) => { captchaToken = t; },
                                     'expired-callback': () => { captchaToken = ''; } });
}

function summary() {
  const n = last.rows.length || 1;
  const count = (codes) => last.rows.filter((r) => codes.includes(r.code)).length;
  return { forestPct: 100 * count(['forest']) / n, noForestPct: 100 * count(['clear', 'noTile']) / n };
}
function showError(code) {
  $('reg-error').textContent = ERRORS[code] || t('reg_failed');
  for (const [k, id] of [['name', 'reg-name'], ['org', 'reg-org'], ['email', 'reg-email']])
    $(id).setAttribute('aria-invalid', String(code.startsWith(k)));
  const focus = { name: 'reg-name', org: 'reg-org', consent: 'reg-consent' }[code] || (code.startsWith('email') ? 'reg-email' : null);
  if (focus) $(focus).focus();
}

$('dl').onclick = () => {
  if (!last) return;
  if (!FORMS_URL) { downloadZip(); return; }        // installations without a registration service
  $('reg-error').textContent = '';
  dlg.showModal();
  setupCaptcha().catch(() => {});
  (saved ? $('reg-consent') : $('reg-name')).focus();
};
$('reg-close').onclick = () => dlg.close();
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });   // click outside the panel

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = {
    name: $('reg-name').value.trim(), org: $('reg-org').value.trim(), email: $('reg-email').value.trim(),
    consent: $('reg-consent').checked, marketing: $('reg-marketing').checked, website: $('reg-website').value,
    summary: summary(), lang: document.documentElement.lang, turnstile: captchaToken,
  };
  // quick checks here; the server checks again, including whether the email domain receives mail
  if (!data.name) return showError('name');
  if (!data.org) return showError('org');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) return showError('email');
  if (!data.consent) return showError('consent');
  if (TURNSTILE_SITEKEY && !captchaToken) return showError('captcha');

  const btn = $('reg-submit');
  btn.disabled = true; btn.textContent = t('reg_checking'); $('reg-error').textContent = '';
  let ok = false, failOpen = false;
  try {
    const r = await fetch(FORMS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const j = await r.json().catch(() => ({}));
    if (j.ok) ok = true;
    else if (r.status >= 500) failOpen = true;
    else showError(j.error || 'server');
  } catch {
    failOpen = true;   // form service unreachable: don't block the user's own results
  }
  btn.disabled = false; btn.textContent = t('reg_btn');
  if (TURNSTILE_SITEKEY && window.turnstile) { turnstile.reset('#reg-captcha'); captchaToken = ''; }
  if (!ok && !failOpen) return;
  try { localStorage.setItem('fc-reg', JSON.stringify({ name: data.name, org: data.org, email: data.email })); } catch {}
  dlg.close();
  await downloadZip();
  say(t('reg_thanks'));
});

// ---------------------------------------------------------------- input
$('file').onchange = (e) => { run([...e.target.files]); e.target.value = ''; };
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); run([...e.dataTransfer.files]); };
$('example').onclick = async () => {
  const blob = await (await fetch(asset('example-plots.geojson'))).blob();
  run([new File([blob], 'example-plots.geojson')]);
};

// ?example=1 runs the example straight away (handy for shared links and automated checks)
if (new URLSearchParams(location.search).has('example')) $('example').click();
