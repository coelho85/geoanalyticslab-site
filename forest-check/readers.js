// Read user uploads (GeoJSON, zipped Shapefile, GeoPackage, KML/KMZ) into GeoJSON
// features in EPSG:4326. Libraries are loaded on demand from CDNs.

import { t, num } from './i18n.js';

const loaded = {};
function loadScript(src) {
  return loaded[src] ??= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => fail(new UserError(t('e_cdn')));
    document.head.appendChild(s);
  });
}
const PROJ4 = 'https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.11.0/proj4.js';
const SHPJS = 'https://unpkg.com/shpjs@4.0.4/dist/shp.min.js';
const SQLJS = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/';
const FFLATE = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/+esm';

// Errors shown to the user: plain language, with what to do next.
export class UserError extends Error {}
const ERR = {
  get json() { return t('e_json'); }, get notGeojson() { return t('e_notGeojson'); }, get zip() { return t('e_zip'); },
  get zipEmpty() { return t('e_zipEmpty'); }, shpParts: (missing) => t('e_shpParts', { missing }), get shp() { return t('e_shp'); },
  get gpkg() { return t('e_gpkg'); }, get gpkgNoLayers() { return t('e_gpkgNoLayers'); }, get kml() { return t('e_kml'); },
  crs: (what) => t('e_crs', { what }), type: (name) => t('e_type', { name }),
};

export async function readFile(file) {
  const name = file.name.toLowerCase();
  const buf = await file.arrayBuffer();
  if (!buf.byteLength) throw new UserError(t('e_empty', { name: file.name }));
  try {
    if (name.endsWith('.zip')) {
      // a .zip is normally a shapefile, but people also zip KML files
      const { unzipSync } = await import(FFLATE);
      const names = [];
      try { unzipSync(new Uint8Array(buf), { filter: (f) => { names.push(f.name); return false; } }); }   // list only
      catch { throw new UserError(ERR.zip); }
      const real = names.filter((n) => !/(^|\/)(__MACOSX\/|\._)/.test(n) && !n.endsWith('/'));   // skip macOS extras and folders
      const pick = (ext) => real.filter((n) => n.toLowerCase().endsWith(ext));
      const has = (ext) => pick(ext).length > 0;
      if (!has('.shp')) {                               // not a shapefile: a zipped GeoPackage, GeoJSON or KML
        if (has('.gpkg')) return await readZipped(buf, pick('.gpkg'), readGeoPackage);
        if (has('.geojson') || has('.json')) return await readZipped(buf, [...pick('.geojson'), ...pick('.json')], readGeoJSON);
        if (has('.kml')) return await readKmz(buf);
        throw new UserError(ERR.zipEmpty);
      }
      const missing = ['.shx', '.dbf'].filter((e) => !has(e));
      if (missing.length) throw new UserError(ERR.shpParts(missing.join(' and ')));
      const out = await readShapefileZip(buf);
      if (!has('.prj')) out.warnings.push(t('w_noprj'));
      return out;
    }
    if (name.endsWith('.gpkg')) return await readGeoPackage(buf);
    if (name.endsWith('.geojson') || name.endsWith('.json')) return await readGeoJSON(buf);
    if (name.endsWith('.kml')) return readKml(new TextDecoder().decode(buf));
    if (name.endsWith('.kmz')) return await readKmz(buf);
  } catch (e) {
    if (e instanceof UserError) throw e;
    console.error(e);
    const kind = name.endsWith('.zip') ? ERR.shp : name.endsWith('.gpkg') ? ERR.gpkg : /\.km[lz]$/.test(name) ? ERR.kml : ERR.json;
    throw new UserError(kind);
  }
  throw new UserError(ERR.type(file.name));
}

// Read files of one type packed in a ZIP and merge them
async function readZipped(buf, names, reader) {
  const { unzipSync } = await import(FFLATE);
  const files = unzipSync(new Uint8Array(buf), { filter: (f) => names.includes(f.name) });
  const out = { features: [], warnings: [], layers: [] };
  for (const n of names) {
    const r = await reader(files[n]);
    out.features.push(...r.features); out.warnings.push(...r.warnings); out.layers.push(...r.layers.map((l) => `${n}: ${l}`));
  }
  if (names.length > 1) out.warnings.push(t('w_zipfiles', { n: names.length }));
  return out;
}

// ---------- GeoJSON ----------
async function readGeoJSON(buf) {
  let obj;
  try { obj = JSON.parse(new TextDecoder().decode(buf).replace(/^\uFEFF/, '')); } catch { throw new UserError(ERR.json); }
  if (!obj || typeof obj !== 'object' || !obj.type) throw new UserError(ERR.notGeojson);
  const feats = obj.type === 'FeatureCollection' ? (Array.isArray(obj.features) ? obj.features : [])
    : obj.type === 'Feature' ? [obj]
    : [{ type: 'Feature', properties: {}, geometry: obj }];
  const crsName = obj.crs?.properties?.name || '';
  const code = crsName.match(/EPSG::?(\d+)/)?.[1];
  const warnings = [];
  if (code && code !== '4326') {
    await loadScript(PROJ4);
    if (!proj4.defs('EPSG:' + code)) throw new UserError(ERR.crs(t('what_geojson', { code })));
    reprojectFeatures(feats, 'EPSG:' + code);
  }
  return { features: feats, warnings, layers: ['(geojson)'] };
}

// ---------- Shapefile (.zip) ----------
async function readShapefileZip(buf) {
  await loadScript(SHPJS);
  let out = await shp(buf);                  // shpjs reprojects using the .prj
  if (!Array.isArray(out)) out = [out];
  const warnings = [];
  const features = [];
  for (const fc of out) for (const f of fc.features) features.push(f);
  return { features, warnings, layers: out.map((fc) => fc.fileName || '(shapefile)') };
}

// ---------- KML / KMZ (Google Earth) ----------
async function readKmz(buf) {
  const { unzipSync } = await import(FFLATE);
  let files;
  try { files = unzipSync(new Uint8Array(buf), { filter: (f) => /\.kml$/i.test(f.name) }); } catch { throw new UserError(ERR.zip); }
  const names = Object.keys(files).sort((a, b) => (/(^|\/)doc\.kml$/i.test(b) ? 1 : 0) - (/(^|\/)doc\.kml$/i.test(a) ? 1 : 0));
  if (!names.length) throw new UserError(t('e_kmzNoKml'));
  const out = { features: [], warnings: [], layers: [] };
  for (const n of names) {
    const r = readKml(new TextDecoder().decode(files[n]));
    out.features.push(...r.features); out.warnings.push(...r.warnings); out.layers.push(n);
  }
  return out;
}

function readKml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new UserError(ERR.kml);
  const kids = (el, tag) => [...el.children].filter((c) => c.localName === tag);
  const kid = (el, tag) => kids(el, tag)[0];
  const coords = (el) => {
    const c = el && kid(el, 'coordinates');
    if (!c) return [];
    return c.textContent.trim().split(/\s+/).map((t) => t.split(',').map(Number)).filter((p) => p.length >= 2 && !isNaN(p[0]) && !isNaN(p[1]))
      .map(([x, y]) => [x, y]);
  };
  const ring = (boundary) => { const lr = boundary && kid(boundary, 'LinearRing'); return lr ? coords(lr) : []; };
  const geometry = (el) => {
    switch (el.localName) {
      case 'Point': { const c = coords(el); return c.length ? { type: 'Point', coordinates: c[0] } : null; }
      case 'Polygon': {
        const outer = ring(kid(el, 'outerBoundaryIs'));
        if (outer.length < 3) return null;
        return { type: 'Polygon', coordinates: [outer, ...kids(el, 'innerBoundaryIs').map(ring).filter((r) => r.length >= 3)] };
      }
      case 'LineString': case 'LinearRing': return { type: 'LineString', coordinates: coords(el) };
      case 'MultiGeometry': {
        const parts = [...el.children].map(geometry).filter(Boolean);
        return parts.length === 1 ? parts[0] : { type: 'GeometryCollection', geometries: parts };
      }
      default: return null;
    }
  };
  const GEOM_TAGS = ['Point', 'Polygon', 'LineString', 'LinearRing', 'MultiGeometry'];
  const features = [];
  for (const pm of doc.getElementsByTagNameNS('*', 'Placemark')) {
    const props = {};
    const name = kid(pm, 'name')?.textContent.trim();
    if (name) props.name = name;
    for (const d of pm.getElementsByTagNameNS('*', 'Data')) {            // <Data name="x"><value>..</value></Data>
      const v = [...d.children].find((c) => c.localName === 'value');
      if (d.getAttribute('name') && v) props[d.getAttribute('name')] = v.textContent.trim();
    }
    for (const d of pm.getElementsByTagNameNS('*', 'SimpleData')) {      // <SchemaData><SimpleData name="x">..</SimpleData>
      if (d.getAttribute('name')) props[d.getAttribute('name')] = d.textContent.trim();
    }
    const gEl = [...pm.children].find((c) => GEOM_TAGS.includes(c.localName));
    features.push({ type: 'Feature', properties: props, geometry: gEl ? geometry(gEl) : null });
  }
  const warnings = features.length ? [] : [t('w_noplacemarks')];
  return { features, warnings, layers: ['(kml)'] };
}

// ---------- GeoPackage ----------
async function readGeoPackage(buf) {
  await loadScript(SQLJS + 'sql-wasm.js');
  const SQL = await initSqlJs({ locateFile: (f) => SQLJS + f });
  let db;
  try { db = new SQL.Database(new Uint8Array(buf)); db.exec('SELECT 1 FROM sqlite_master LIMIT 1'); }
  catch { throw new UserError(ERR.gpkg); }
  const warnings = [], features = [], layers = [];
  try {
    let gc;
    try { gc = db.exec('SELECT table_name, column_name, srs_id FROM gpkg_geometry_columns'); } catch { throw new UserError(ERR.gpkg); }
    if (!gc.length) throw new UserError(ERR.gpkgNoLayers);
    for (const [table, geomCol, srsId] of gc[0].values) {
      layers.push(table);
      const srs = db.exec('SELECT definition, organization, organization_coordsys_id FROM gpkg_spatial_ref_sys WHERE srs_id = ?', [srsId]);
      const [def, org, orgId] = srs[0]?.values[0] || [];
      const is4326 = (String(org).toUpperCase() === 'EPSG' && orgId === 4326) || srsId === 4326;
      const q = '"' + String(table).replace(/"/g, '""') + '"';
      const rs = db.exec(`SELECT * FROM ${q}`);
      if (!rs.length) continue;
      const cols = rs[0].columns, gi = cols.indexOf(geomCol);
      const layerFeats = [];
      for (const row of rs[0].values) {
        const props = {};
        cols.forEach((c, k) => { if (k !== gi && !(row[k] instanceof Uint8Array)) props[c] = row[k]; });
        let geometry = null;
        try { geometry = row[gi] ? parseGpkgGeometry(row[gi]) : null; } catch { geometry = { type: 'Invalid' }; }   // one bad row, not the whole file
        layerFeats.push({ type: 'Feature', properties: props, geometry });
      }
      if (!is4326) {
        await loadScript(PROJ4);
        const from = String(org).toUpperCase() === 'EPSG' && proj4.defs('EPSG:' + orgId) ? 'EPSG:' + orgId : def;
        if (!from || from === 'undefined') throw new UserError(ERR.crs(t('what_layer', { name: table })));
        try { reprojectFeatures(layerFeats, from); } catch { throw new UserError(ERR.crs(t('what_layer', { name: table }))); }
        warnings.push(t('w_reprojected', { layer: table, from: `${org}:${orgId}` }));
      }
      features.push(...layerFeats);
    }
  } finally { db.close(); }
  if (layers.length > 1) warnings.push(t('w_layers', { n: layers.length }));
  return { features, warnings, layers };
}

// GeoPackage geometry blob = 'GP' header (+ optional envelope) + standard WKB
function parseGpkgGeometry(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8[0] !== 0x47 || u8[1] !== 0x50) throw new Error('Invalid GeoPackage geometry');
  const flags = u8[3];
  if ((flags >> 4) & 1) return null;                        // empty geometry
  const envLen = [0, 32, 48, 48, 64][(flags >> 1) & 7];
  return readWkb(dv, 8 + envLen).geom;
}

function readWkb(dv, o) {
  const le = dv.getUint8(o) === 1; o += 1;
  let t = dv.getUint32(o, le); o += 4;
  let hasZ = !!(t & 0x80000000), hasM = !!(t & 0x40000000);
  if (t & 0x20000000) o += 4;                                // EWKB SRID
  t &= 0x0fffffff;
  if (t >= 1000) { const d = Math.floor(t / 1000); t %= 1000; hasZ ||= d === 1 || d === 3; hasM ||= d === 2 || d === 3; }
  const step = 8 * (2 + hasZ + hasM);
  const pt = () => { const c = [dv.getFloat64(o, le), dv.getFloat64(o + 8, le)]; o += step; return c; };
  const u32 = () => { const v = dv.getUint32(o, le); o += 4; return v; };
  const ring = () => Array.from({ length: u32() }, pt);
  const multi = () => Array.from({ length: u32() }, () => { const r = readWkb(dv, o); o = r.o; return r.geom; });
  let geom;
  switch (t) {
    case 1: geom = { type: 'Point', coordinates: pt() }; break;
    case 2: geom = { type: 'LineString', coordinates: ring() }; break;
    case 3: geom = { type: 'Polygon', coordinates: Array.from({ length: u32() }, ring) }; break;
    case 4: geom = { type: 'MultiPoint', coordinates: multi().map((g) => g.coordinates) }; break;
    case 5: geom = { type: 'MultiLineString', coordinates: multi().map((g) => g.coordinates) }; break;
    case 6: geom = { type: 'MultiPolygon', coordinates: multi().map((g) => g.coordinates) }; break;
    case 7: geom = { type: 'GeometryCollection', geometries: multi() }; break;
    default: throw new Error('Unsupported WKB geometry type ' + t);
  }
  return { geom, o };
}

// ---------- helpers ----------
function reprojectFeatures(feats, from) {
  const tr = proj4(from, 'EPSG:4326');
  const map = (c) => typeof c[0] === 'number' ? tr.forward([c[0], c[1]]) : c.map(map);
  const geom = (g) => {
    if (!g) return g;
    if (g.type === 'GeometryCollection') return { ...g, geometries: g.geometries.map(geom) };
    return { ...g, coordinates: map(g.coordinates) };
  };
  for (const f of feats) f.geometry = geom(f.geometry);
}

// ---------- checks + conversion to the compact form the worker expects ----------
export const MAX_PLOT_HA = 100000;       // larger "plots" are regions, not farms (and would download a lot of map data)
export const MIN_PLOT_HA = 0.01;         // about one 10 m map pixel

const ID_KEYS = ['plot_id', 'PLOT_ID', 'plotid', 'id', 'ID', 'name', 'NAME', 'ProducerName'];
const okCoord = (c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]);
const inRange = (c) => Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90;

function cleanRing(ring) {                // drop invalid/duplicate points, return open ring [[x,y],...]
  const out = [];
  for (const c of ring || []) {
    if (!okCoord(c)) continue;
    const l = out[out.length - 1];
    if (!l || l[0] !== c[0] || l[1] !== c[1]) out.push([c[0], c[1]]);
  }
  if (out.length > 1) { const a = out[0], b = out[out.length - 1]; if (a[0] === b[0] && a[1] === b[1]) out.pop(); }
  return out;
}
function ringAreaHa(r) {                  // planar area with a local metric scale; plenty for checks
  const lat0 = r.reduce((s, c) => s + c[1], 0) / r.length, kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110574;
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * kx) * (r[i][1] * ky) - (r[i][0] * kx) * (r[j][1] * ky);
  return Math.abs(a) / 2 / 1e4;
}
function inside([x, y], r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if ((r[i][1] > y) !== (r[j][1] > y) && x < (r[j][0] - r[i][0]) * (y - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  return c;
}
function selfIntersects(r) {              // any two non-adjacent edges crossing (skipped for huge rings)
  const n = r.length;
  if (n < 4 || n > 3000) return false;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++) {
    const a = r[i], b = r[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;           // adjacent through the closing edge
      const c = r[j], d = r[(j + 1) % n];
      const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
      if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)) && d1 && d2 && d3 && d4) return true;
    }
  }
  return false;
}

export function toPlots(features) {
  const plots = [], skipped = [];
  let outOfRange = 0, checked = 0;
  features.forEach((f, idx) => {   // f may be replaced below (GeometryCollection)
    const props = f?.properties || {};
    const idKey = ID_KEYS.find((k) => props[k] != null && props[k] !== '');
    const id = idKey ? String(props[idKey]) : `#${idx + 1}`;
    let g = f?.geometry;
    if (!g) { skipped.push({ id, reason: t('r_nogeom') }); return; }
    if (g.type === 'Invalid') { skipped.push({ id, reason: t('r_damaged') }); return; }
    if (g.type === 'GeometryCollection') {            // e.g. KML MultiGeometry: use its polygons, else its points
      const flat = (x) => x.type === 'GeometryCollection' ? x.geometries.flatMap(flat) : [x];
      const parts = flat(g);
      const polys = parts.flatMap((x) => x.type === 'Polygon' ? [x.coordinates] : x.type === 'MultiPolygon' ? x.coordinates : []);
      const pts = parts.flatMap((x) => x.type === 'Point' ? [x.coordinates] : x.type === 'MultiPoint' ? x.coordinates : []);
      g = polys.length ? { type: 'MultiPolygon', coordinates: polys } : pts.length ? { type: 'MultiPoint', coordinates: pts } : g;
      f = { ...f, geometry: g };                     // the map and the downloads get the simplified geometry too
    }
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null;
    if (polys) {
      const notes = [], parts = [], rings = [];
      let areaHa = 0, approx = false, holeOutside = false, coords = 0, bad = 0;
      for (const poly of polys || []) {
        const outer = cleanRing(poly?.[0]);
        if (outer.length < 3) continue;
        coords += outer.length; bad += outer.filter((c) => !inRange(c)).length;
        let ringsHere = [outer], a = ringAreaHa(outer);
        if (selfIntersects(outer)) approx = true;
        for (const h of (poly || []).slice(1)) {
          const hole = cleanRing(h);
          if (hole.length < 3) continue;
          if (!inside(hole[0], outer)) { notes.push(t('n_holeoutside')); holeOutside = true; continue; }
          ringsHere.push(hole); a -= ringAreaHa(hole);
        }
        parts.push(ringsHere.length); rings.push(...ringsHere); areaHa += Math.max(a, 0);
      }
      if (!rings.length) { skipped.push({ id, reason: t('r_invalidpoly') }); return; }
      checked++; if (bad > coords / 2) outOfRange++;
      if (approx) notes.push(t('n_selfint'));
      if (areaHa > MAX_PLOT_HA) {
        skipped.push({ id, reason: t('r_toolarge', { ha: num(Math.round(areaHa)), max: num(MAX_PLOT_HA) }),
                       code: 'tooLarge', feature: f });
        return;
      }
      const typed = rings.map((ring) => {
        const t = new Float64Array(ring.length * 2);
        ring.forEach(([x, y], k) => { t[2 * k] = x; t[2 * k + 1] = y; });
        return t;
      });
      plots.push({ id, kind: 'polygon', rings: typed, parts, approxHa: areaHa, approx, holeOutside, notes, feature: f });
      return;
    }
    let pt = g.type === 'Point' ? g.coordinates : g.type === 'MultiPoint' ? g.coordinates?.[0] : null;
    if (pt) {
      if (!okCoord(pt)) { skipped.push({ id, reason: t('r_invalidcoords') }); return; }
      checked++; if (!inRange(pt)) outOfRange++;
      const multi = g.type === 'MultiPoint' && g.coordinates.length > 1;
      plots.push({ id, kind: 'point', lon: pt[0], lat: pt[1], notes: multi ? [t('n_multi')] : [], multi, feature: f });
      return;
    }
    skipped.push({ id, reason: t('r_unsupported', { type: g.type }) });
  });
  return { plots, skipped, outOfRange, checked };
}
