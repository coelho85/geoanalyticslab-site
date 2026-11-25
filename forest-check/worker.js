// Forest-in-polygon analysis against COG(s), entirely in the browser.
// Works with a single COG or with a tile set (JRC 10° tiles named by upper-left corner).
// Everything is computed in one global pixel grid, so plots crossing tile edges are exact.
import { fromUrl } from 'https://cdn.jsdelivr.net/npm/geotiff@3.0.5/+esm';

const R = 6371007.181;          // authalic Earth radius (m)

// Count bytes actually downloaded (geotiff.js uses fetch internally).
let bytes = 0, requests = 0;
const _fetch = self.fetch.bind(self);
// Safety net: if a server answers a Range request with the whole file (HTTP 200),
// cancel that download immediately and retry, instead of pulling hundreds of MB.
self.fetch = async (input, init = {}) => {
  const h = init.headers;
  const range = h && (h instanceof Headers ? h.get('Range') : (h.Range || h.range));
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  for (let attempt = 0, busy = 0; ; attempt++) {
    // Network errors, 429 (Cloudflare rate limit; its block page has no CORS headers, so the browser
    // reports it as a network error) and 5xx: back off 1, 2, 4, 8, 16 s (the block lasts 10 s).
    let res;
    try {
      res = await _fetch(input, init);
    } catch (err) {
      if (init.signal?.aborted || busy >= 5) throw err;
      await wait(1000 * 2 ** busy++); continue;
    }
    requests++;
    if ((res.status === 429 || res.status >= 500) && busy < 5) {
      res.body?.cancel();
      await wait(1000 * 2 ** busy++); continue;
    }
    if (range && res.status === 200) {
      res.body?.cancel();
      if (attempt < 3) { await new Promise((ok) => setTimeout(ok, 300 * (attempt + 1))); continue; }
      throw new Error('The map server ignored a partial-download request; please try again later.');
    }
    bytes += Number(res.headers.get('content-length')) || 0;
    return res;
  }
};

self.onmessage = async (e) => {
  try {
    const out = await run(e.data);
    self.postMessage({ type: 'done', ...out });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack || err) });
  }
};

// ---------- sources ----------
// A "grid" describes the global pixel grid and how to get the tile covering (tx, ty).
async function openGrid(source, tiffOpts) {
  if (source.type === 'single') {
    const img = await (await fromUrl(source.url, tiffOpts)).getImage(0);
    const [ox, oy] = img.getOrigin();
    const [res] = img.getResolution();
    const W = img.getWidth(), H = img.getHeight();
    return { ox, oy, res, W, H, tileW: W, tileH: H, tileUrl: () => source.url, preopened: img };
  }
  // tile set described by a manifest
  const m = await (await fetch(source.manifest)).json();
  const base = new URL('.', new URL(source.manifest, self.location.href)).href;
  const res = m.res, tilePx = Math.round(m.tileDeg / res);
  const available = new Set(m.tiles);
  const excluded = new Set(m.excluded || []);       // tiles deliberately left out of the service
  const label = (v, pos, neg) => (v >= 0 ? pos : neg) + Math.abs(Math.round(v));
  return {
    ox: m.originLon, oy: m.originLat, res,
    W: Math.round(360 / res), H: Math.round((m.originLat + 90) / res),
    tileW: tilePx, tileH: tilePx,
    tileName: (tx, ty) => label(m.originLat - ty * m.tileDeg, 'N', 'S') + '_' + label(m.originLon + tx * m.tileDeg, 'E', 'W'),
    tileUrl(tx, ty) { const n = this.tileName(tx, ty); return available.has(n) ? base + m.pattern.replace('{tile}', n) : null; },
    isExcluded(tx, ty) { return excluded.has(this.tileName(tx, ty)); },
  };
}

async function run({ source, plots, opts = {} }) {
  bytes = 0; requests = 0;
  const CONCURRENCY = opts.concurrency || 16;     // parallel block fetches
  const blockSize = opts.blockSize ?? 65536;      // group small reads (tile index) into 64 KB blocks
  const tiffOpts = blockSize ? { allowFullFile: false, blockSize, cacheSize: 200 } : { allowFullFile: false };
  const t0 = performance.now();
  const G = await openGrid(source, tiffOpts);
  const { ox, oy, res, W, H, tileW, tileH } = G;
  const nTx = Math.ceil(W / tileW);

  // Tiles are opened lazily, once each.
  const tiles = new Map();                          // tileKey -> Promise<{img, TW, TH} | null>
  const openTile = (tx, ty) => {
    const k = ty * nTx + tx;
    if (!tiles.has(k)) tiles.set(k, (async () => {
      if (G.preopened) return wrap(G.preopened);
      const url = G.tileUrl(tx, ty);
      if (!url) return null;
      const img = await (await fromUrl(url, tiffOpts)).getImage(0);
      const [tox, toy] = img.getOrigin();
      const exp = [ox + tx * tileW * res, oy - ty * tileH * res];
      if (Math.abs(tox - exp[0]) > res / 2 || Math.abs(toy - exp[1]) > res / 2)
        throw new Error(`Tile ${url} is not on the expected grid`);
      return wrap(img);
    })());
    return tiles.get(k);
  };
  const wrap = (img) => ({ img, TW: img.getTileWidth(), TH: img.getTileHeight() });

  // Area of one pixel in a global row (depends on latitude only).
  const k = R * R * (res * Math.PI / 180);
  const rowArea = (r) => {
    const a = (oy - r * res) * Math.PI / 180, b = (oy - (r + 1) * res) * Math.PI / 180;
    return k * Math.abs(Math.sin(a) - Math.sin(b));
  };

  // 1. Plots -> global pixel space -> tiles they touch.
  const res_ = plots.map((p) => ({ id: p.id, kind: p.kind }));
  const tilePlots = new Map();                      // tileKey -> [plot index]
  const addTile = (tx, ty, i) => { const kk = ty * nTx + tx; let l = tilePlots.get(kk); if (!l) tilePlots.set(kk, l = []); l.push(i); };
  plots.forEach((p, i) => {
    const r = res_[i];
    if (p.kind === 'point') {
      const col = Math.floor((p.lon - ox) / res), row = Math.floor((oy - p.lat) / res);
      if (col < 0 || row < 0 || col >= W || row >= H) { r.outside = true; return; }
      Object.assign(p, { col, row, c0: col, c1: col, r0: row, r1: row });
      addTile(Math.floor(col / tileW), Math.floor(row / tileH), i);
      return;
    }
    let n = 0; for (const ring of p.rings) n += ring.length / 2;
    const edges = new Float64Array(n * 4);
    let e = 0, ri = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    // Edges are grouped by polygon part (outer ring + its holes). Within a part the even-odd rule
    // gives the holes; across parts the pixels are merged (union), so overlapping parts count once.
    p.partEnds = [];
    for (const nRings of (p.parts || [p.rings.length])) {
      for (let k = 0; k < nRings; k++) {
        const ring = p.rings[ri++], m = ring.length / 2;
        for (let j = 0; j < m; j++) {
          const jj = (j + 1) % m;
          const x1 = (ring[2 * j] - ox) / res, y1 = (oy - ring[2 * j + 1]) / res;
          const x2 = (ring[2 * jj] - ox) / res, y2 = (oy - ring[2 * jj + 1]) / res;
          edges[e++] = x1; edges[e++] = y1; edges[e++] = x2; edges[e++] = y2;
          if (x1 < minX) minX = x1; if (x1 > maxX) maxX = x1;
          if (y1 < minY) minY = y1; if (y1 > maxY) maxY = y1;
        }
      }
      p.partEnds.push(e);
    }
    p.edges = edges.subarray(0, e);
    if (maxX < 0 || maxY < 0 || minX > W || minY > H) { r.outside = true; return; }
    r.partial = minX < 0 || minY < 0 || maxX > W || maxY > H;
    p.r0 = Math.max(0, Math.ceil(minY - 0.5)); p.r1 = Math.min(H - 1, Math.floor(maxY - 0.5));
    p.c0 = Math.max(0, Math.ceil(minX - 0.5)); p.c1 = Math.min(W - 1, Math.floor(maxX - 0.5));
    Object.assign(r, { px: 0, forestPx: 0, totalM2: 0, forestM2: 0 });
    if (p.r0 > p.r1 || p.c0 > p.c1) return;        // smaller than a pixel centre
    for (let ty = Math.floor(p.r0 / tileH); ty <= Math.floor(p.r1 / tileH); ty++)
      for (let tx = Math.floor(p.c0 / tileW); tx <= Math.floor(p.c1 / tileW); tx++) addTile(tx, ty, i);
  });

  // 2. Open the tiles needed and plan blocks (one job per block, or per missing tile).
  const jobs = [];
  await Promise.all([...tilePlots.entries()].map(async ([tk, idx]) => {
    const tx = tk % nTx, ty = (tk - tx) / nTx;
    const gx = tx * tileW, gy = ty * tileH;         // tile offset in global pixels
    const t = await openTile(tx, ty);
    if (!t) {
      if (G.isExcluded?.(tx, ty)) {                 // outside the service area: no result for this part
        for (const i of idx) res_[i].notCovered = true;
        return;
      }
      // no map tile = no forest mapped there (e.g. ocean); area is still computed
      jobs.push({ t: null, gx, gy, x0: gx, y0: gy, x1: gx + tileW, y1: gy + tileH, idx });
      for (const i of idx) res_[i].missingTile = true;
      return;
    }
    const blocks = new Map();
    for (const i of idx) {
      const p = plots[i];
      const c0 = Math.max(p.c0, gx) - gx, c1 = Math.min(p.c1, gx + tileW - 1) - gx;
      const r0 = Math.max(p.r0, gy) - gy, r1 = Math.min(p.r1, gy + tileH - 1) - gy;
      for (let by = Math.floor(r0 / t.TH); by <= Math.floor(r1 / t.TH); by++)
        for (let bx = Math.floor(c0 / t.TW); bx <= Math.floor(c1 / t.TW); bx++) {
          const bk = by * 100000 + bx;
          let l = blocks.get(bk); if (!l) blocks.set(bk, l = []); l.push(i);
        }
    }
    const tw = t.img.getWidth(), th = t.img.getHeight();
    for (const [bk, l] of blocks) {
      const bx = bk % 100000, by = (bk - bx) / 100000;
      const lx0 = bx * t.TW, ly0 = by * t.TH;
      jobs.push({ t, gx, gy, lx0, ly0, lx1: Math.min(lx0 + t.TW, tw), ly1: Math.min(ly0 + t.TH, th),
                  x0: gx + lx0, y0: gy + ly0, x1: gx + Math.min(lx0 + t.TW, tw), y1: gy + Math.min(ly0 + t.TH, th), idx: l });
    }
  }));
  jobs.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);  // row-major = good locality
  const headerMs = performance.now() - t0, headerBytes = bytes;

  // 3. Fetch each block once and evaluate every plot touching it (global coordinates).
  let done = 0;
  const xs = [], iv = [];
  async function processJob(J) {
    const data = J.t ? (await J.t.img.readRasters({ window: [J.lx0, J.ly0, J.lx1, J.ly1], samples: [0] }))[0] : null;
    const bw = J.x1 - J.x0;
    for (const i of J.idx) {
      const p = plots[i], r = res_[i];
      if (p.kind === 'point') { r.forest = data && data[(p.row - J.y0) * bw + (p.col - J.x0)] === 1 ? 1 : 0; continue; }
      const ra = Math.max(p.r0, J.y0), rb = Math.min(p.r1, J.y1 - 1);
      const ca = Math.max(p.c0, J.x0), cb = Math.min(p.c1, J.x1 - 1);
      const E = p.edges;
      for (let row = ra; row <= rb; row++) {
        const yc = row + 0.5;
        iv.length = 0;                                // pixel column intervals [lo, hi] covered in this row
        let start = 0;
        for (const end of p.partEnds) {
          xs.length = 0;
          for (let q = start; q < end; q += 4) {
            const ya = E[q + 1], yb = E[q + 3];
            if ((ya <= yc) !== (yb <= yc)) xs.push(E[q] + (yc - ya) * (E[q + 2] - E[q]) / (yb - ya));
          }
          start = end;
          if (xs.length < 2) continue;
          xs.sort((a, b) => a - b);
          for (let s = 0; s + 1 < xs.length; s += 2) {
            const lo = Math.max(Math.ceil(xs[s] - 0.5), ca), hi = Math.min(Math.ceil(xs[s + 1] - 0.5) - 1, cb);
            if (hi >= lo) iv.push([lo, hi]);
          }
        }
        if (!iv.length) continue;
        if (p.partEnds.length > 1) iv.sort((a, b) => a[0] - b[0]);
        let n = 0, f = 0, upto = -Infinity;           // columns up to `upto` already counted (merges overlaps)
        const off = (row - J.y0) * bw - J.x0;
        for (const [lo0, hi] of iv) {
          const lo = Math.max(lo0, upto + 1);
          if (hi < lo) continue;
          n += hi - lo + 1;
          if (data) for (let c = lo; c <= hi; c++) if (data[off + c] === 1) f++;
          upto = Math.max(upto, hi);
        }
        if (n) { const a = rowArea(row); r.px += n; r.forestPx += f; r.totalM2 += n * a; r.forestM2 += f * a; }
      }
    }
    done++;
    if (done % 5 === 0 || done === jobs.length) self.postMessage({ type: 'progress', done, total: jobs.length });
  }
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) await processJob(jobs[next++]);
  }));

  for (const r of res_) if (r.totalM2 !== undefined) {
    r.totalHa = r.totalM2 / 1e4; r.forestHa = r.forestM2 / 1e4;
    r.forestPct = r.px ? 100 * r.forestPx / r.px : 0;
    delete r.totalM2; delete r.forestM2;
  }
  const openedTiles = (await Promise.all(tiles.values())).filter(Boolean).length;
  return {
    results: res_,
    stats: { headerMs, headerBytes, blocks: jobs.filter((j) => j.t).length, tiles: openedTiles,
             missingTiles: jobs.filter((j) => !j.t).length, bytes, requests, totalMs: performance.now() - t0 },
  };
}
