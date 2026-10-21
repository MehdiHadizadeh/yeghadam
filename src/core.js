/*
 * Yeghadam: shared core (no DOM).
 * Geometry, vector-tile decoding, walking graph, candidate points, search and ranking.
 * Used by the browser extension and the Android WebView build; loadable in Node for tests.
 * Network access goes only through the callbacks the caller passes in (quote / getFeatures).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.YeghadamCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EARTH_R = 6371008.8;
  const MIN_SAVING = 10000; // rial (1,000 toman): Snapp rounds prices to 1,000 toman
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  /* ---------------- geometry ---------------- */
  function distance(a, b) {
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.sqrt(h));
  }
  // Local equirectangular projection in meters (x east, y north) around o.
  function projector(o) {
    const ky = rad(1) * EARTH_R, kx = ky * Math.cos(rad(o.lat));
    return {
      xy: (lng, lat) => [(lng - o.lng) * kx, (lat - o.lat) * ky],
      ll: (x, y) => ({ lat: o.lat + y / ky, lng: o.lng + x / kx }),
    };
  }
  const DIRS = ['شمال', 'شمال‌شرق', 'شرق', 'جنوب‌شرق', 'جنوب', 'جنوب‌غرب', 'غرب', 'شمال‌غرب'];
  const direction = (east, north) => DIRS[((Math.round(deg(Math.atan2(east, north)) / 45) % 8) + 8) % 8];

  /* ---------------- vector tiles (MVT) ---------------- */
  const TILE_Z = 14;
  function tileOf(lng, lat, z) {
    const n = 2 ** z, lr = rad(lat);
    return {
      z,
      x: Math.floor(((lng + 180) / 360) * n),
      y: Math.floor(((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n),
    };
  }
  // Tiles covering a square of half-size R meters around p.
  function tilesAround(p, R, z) {
    z = z || TILE_Z;
    const pr = projector(p), sw = pr.ll(-R, -R), ne = pr.ll(R, R);
    const a = tileOf(sw.lng, ne.lat, z), b = tileOf(ne.lng, sw.lat, z);
    const out = [];
    for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) out.push({ z, x, y });
    return out;
  }

  function Reader(buf) { this.b = buf; this.p = 0; }
  Reader.prototype.varint = function () {
    let v = 0, s = 1, c;
    do { c = this.b[this.p++]; v += (c & 0x7f) * s; s *= 128; } while (c & 0x80);
    return v;
  };
  Reader.prototype.bytes = function () {
    const n = this.varint(), s = this.p;
    this.p += n;
    return this.b.subarray(s, this.p);
  };
  Reader.prototype.skip = function (wt) {
    if (wt === 0) this.varint();
    else if (wt === 1) this.p += 8;
    else if (wt === 2) { const n = this.varint(); this.p += n; }
    else if (wt === 5) this.p += 4;
    else throw new Error('pbf wire type ' + wt);
  };
  const utf8 = new TextDecoder();
  const zigzag = (n) => (n >>> 1) ^ -(n & 1);
  function packed(buf) {
    const r = new Reader(buf), out = [];
    while (r.p < buf.length) out.push(r.varint());
    return out;
  }
  function decodeValue(buf) {
    const r = new Reader(buf);
    let v = null;
    while (r.p < buf.length) {
      const tag = r.varint(), f = tag >> 3;
      if (f === 1) v = utf8.decode(r.bytes());
      else if (f === 2) { v = new DataView(buf.buffer, buf.byteOffset + r.p, 4).getFloat32(0, true); r.p += 4; }
      else if (f === 3) { v = new DataView(buf.buffer, buf.byteOffset + r.p, 8).getFloat64(0, true); r.p += 8; }
      else if (f === 4 || f === 5) v = r.varint();
      else if (f === 6) { const n = r.varint(); v = n % 2 ? -(n + 1) / 2 : n / 2; }
      else if (f === 7) v = !!r.varint();
      else r.skip(tag & 7);
    }
    return v;
  }
  // Line features of one layer → [{ props, lines: [[[lng, lat], ...], ...] }].
  function decodeTile(buf, tile, layerName) {
    layerName = layerName || 'transportation';
    const r = new Reader(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
    const out = [];
    while (r.p < r.b.length) {
      const tag = r.varint();
      if (tag >> 3 === 3 && (tag & 7) === 2) decodeLayer(r.bytes(), tile, layerName, out);
      else r.skip(tag & 7);
    }
    return out;
  }
  function decodeLayer(buf, tile, want, out) {
    const r = new Reader(buf), keys = [], values = [], feats = [];
    let name = '', extent = 4096;
    while (r.p < buf.length) {
      const tag = r.varint(), f = tag >> 3;
      if (f === 1) name = utf8.decode(r.bytes());
      else if (f === 2) feats.push(r.bytes());
      else if (f === 3) keys.push(utf8.decode(r.bytes()));
      else if (f === 4) values.push(decodeValue(r.bytes()));
      else if (f === 5) extent = r.varint();
      else r.skip(tag & 7);
    }
    if (name !== want) return;
    const n = 2 ** tile.z;
    const toLL = (px, py) => [
      ((tile.x + px / extent) / n) * 360 - 180,
      deg(Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + py / extent)) / n)))),
    ];
    for (const fb of feats) {
      const fr = new Reader(fb);
      let type = 0, tags = [], geom = [];
      while (fr.p < fb.length) {
        const tag = fr.varint(), f = tag >> 3;
        if (f === 2) tags = packed(fr.bytes());
        else if (f === 3) type = fr.varint();
        else if (f === 4) geom = packed(fr.bytes());
        else fr.skip(tag & 7);
      }
      if (type !== 2) continue;
      const props = {};
      for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
      const lines = [];
      let line = null, x = 0, y = 0, i = 0;
      while (i < geom.length) {
        const c = geom[i++], cmd = c & 7, cnt = c >>> 3;
        if (cmd === 7) continue;
        for (let k = 0; k < cnt; k++) {
          x += zigzag(geom[i++]); y += zigzag(geom[i++]);
          if (cmd === 1) { line = [toLL(x, y)]; lines.push(line); }
          else if (cmd === 2 && line) line.push(toLL(x, y));
        }
      }
      const ok = lines.filter((l) => l.length > 1);
      if (ok.length) out.push({ props, lines: ok });
    }
  }

  /* ---------------- walking graph ---------------- */
  // Pedestrians cannot walk along these; cars cannot stop on anything outside STOP.
  const NO_WALK = new Set(['motorway', 'trunk', 'construction', 'rail', 'transit', 'ferry', 'raceway', 'busway']);
  const STOP = new Set(['primary', 'secondary', 'tertiary', 'minor', 'service']);
  // Extra walking cost (m) for crossing a divided road of this class at an arbitrary point.
  const CROSS_PENALTY = { primary: 20, secondary: 10, tertiary: 5 };
  const STEP = 10; // densify segments to this length (m)
  const yes = (v) => v === 1 || v === true || v === '1' || v === 'yes';

  function edgeInfo(p) {
    const cls = String(p.class || ''), ramp = yes(p.ramp), closed = yes(p.is_closed);
    const tunnel = p.brunnel === 'tunnel', bridge = p.brunnel === 'bridge';
    return {
      cls,
      name: p.name || '',
      osm: p.osm_id,
      oneway: p.oneway === 1 || p.oneway === -1 ? p.oneway : 0,
      walk: !NO_WALK.has(cls) && !ramp && !closed && !tunnel,
      stop: STOP.has(cls) && !ramp && !closed && !tunnel && !bridge && p.service !== 'parking_aisle',
    };
  }

  // features: [{ props, lines: [[[lng, lat], ...]] }] (decodeTile output or map.querySourceFeatures adapted)
  function buildGraph(features, center, R) {
    const pr = projector(center), lim = R + 60, CELL = 3;
    const nodes = [], segs = [], grid = new Map();
    function nodeAt(x, y) {
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const list = grid.get(cx + i + ':' + (cy + j));
        if (!list) continue;
        for (const id of list) if (Math.abs(nodes[id].x - x) < 1.2 && Math.abs(nodes[id].y - y) < 1.2) return id;
      }
      const id = nodes.length;
      nodes.push({ x, y, adj: [], walk: false, stop: -1 });
      const k = cx + ':' + cy;
      (grid.get(k) || grid.set(k, []).get(k)).push(id);
      return id;
    }
    function link(a, b, len, seg) {
      if (a === b) return;
      if (nodes[a].adj.some((e) => e.to === b && e.seg === seg)) return;
      nodes[a].adj.push({ to: b, len, seg });
      nodes[b].adj.push({ to: a, len, seg });
    }
    for (const f of features) {
      const info = edgeInfo(f.props || {});
      if (!info.walk && !info.stop) continue;
      for (const line of f.lines) {
        for (let i = 0; i + 1 < line.length; i++) {
          const [x0, y0] = pr.xy(line[i][0], line[i][1]), [x1, y1] = pr.xy(line[i + 1][0], line[i + 1][1]);
          const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
          if (L < 0.01) continue;
          const t = Math.max(0, Math.min(1, -(x0 * dx + y0 * dy) / (L * L)));
          if (Math.hypot(x0 + t * dx, y0 + t * dy) > lim) continue;
          let bearing = deg(Math.atan2(dx, dy));
          if (info.oneway === -1) bearing += 180;
          const parts = Math.max(1, Math.ceil(L / STEP));
          let prev = nodeAt(x0, y0);
          for (let k = 1; k <= parts; k++) {
            const id = nodeAt(x0 + (dx * k) / parts, y0 + (dy * k) / parts);
            const si = segs.length;
            segs.push({ a: prev, b: id, len: L / parts, info, bearing: ((bearing % 360) + 360) % 360 });
            link(prev, id, L / parts, si);
            for (const n of [prev, id]) {
              if (info.walk) nodes[n].walk = true;
              if (info.stop && nodes[n].stop < 0) nodes[n].stop = si;
            }
            prev = id;
          }
        }
      }
    }
    addJunctions(nodes, segs);
    addCrossings(nodes, segs);
    return { pr, center, nodes, segs };
  }

  // Vector tiles often drop the shared vertex of a T-junction, leaving the side street's end a metre or two short of
  // the road it meets (dozens of such gaps in a typical 500 m neighbourhood). Join each loose end to the
  // walkable segment it nearly touches, through both of that segment's ends. Join edges use seg = -2.
  const JOIN = -2, CROSS = -1;
  function addJunctions(nodes, segs) {
    const CELL = 10, grid = new Map(), REACH = 4;
    segs.forEach((s, i) => {
      if (!s.info.walk) return;
      const a = nodes[s.a], b = nodes[s.b];
      const k = Math.floor((a.x + b.x) / 2 / CELL) + ':' + Math.floor((a.y + b.y) / 2 / CELL);
      (grid.get(k) || grid.set(k, []).get(k)).push(i);
    });
    nodes.forEach((n, i) => {
      if (n.adj.filter((e) => e.seg >= 0).length !== 1) return;
      const own = n.adj.find((e) => e.seg >= 0).seg;
      const cx = Math.floor(n.x / CELL), cy = Math.floor(n.y / CELL);
      let best = null;
      for (let u = -1; u <= 1; u++) for (let v = -1; v <= 1; v++) {
        for (const j of grid.get(cx + u + ':' + (cy + v)) || []) {
          const s = segs[j];
          if (j === own || s.a === i || s.b === i) continue;
          const A = nodes[s.a], B = nodes[s.b], dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((n.x - A.x) * dx + (n.y - A.y) * dy) / L2));
          const d = Math.hypot(A.x + t * dx - n.x, A.y + t * dy - n.y);
          if (d < REACH && (!best || d < best.d)) best = { s, t, d };
        }
      }
      if (!best) return;
      const { s, t, d } = best;
      for (const [to, len] of [[s.a, d + t * s.len], [s.b, d + (1 - t) * s.len]]) {
        n.adj.push({ to, len, seg: JOIN });
        nodes[to].adj.push({ to: i, len, seg: JOIN });
      }
      n.walk = true;
    });
  }

  // Divided roads are two parallel one-way carriageways with no shared nodes between intersections.
  // A pedestrian can cross anywhere, so link each carriageway node to the nearest node on the opposite one.
  function addCrossings(nodes, segs) {
    const CELL = 30, grid = new Map();
    const divided = [];
    segs.forEach((s, i) => {
      if (!s.info.oneway || CROSS_PENALTY[s.info.cls] == null) return;
      divided.push(i);
      const a = nodes[s.a], b = nodes[s.b];
      const k = Math.floor((a.x + b.x) / 2 / CELL) + ':' + Math.floor((a.y + b.y) / 2 / CELL);
      (grid.get(k) || grid.set(k, []).get(k)).push(i);
    });
    const done = new Set();
    for (const i of divided) {
      const s = segs[i], A = nodes[s.a];
      const cx = Math.floor(A.x / CELL), cy = Math.floor(A.y / CELL);
      let best = null;
      for (let u = -1; u <= 1; u++) for (let v = -1; v <= 1; v++) {
        for (const j of grid.get(cx + u + ':' + (cy + v)) || []) {
          const t = segs[j];
          if (j === i || t.info.osm === s.info.osm && t.bearing === s.bearing) continue;
          const diff = Math.abs(((t.bearing - s.bearing + 720) % 360) - 180); // 0 = exactly opposite
          if (diff > 25) continue;
          for (const n of [t.a, t.b]) {
            const d = Math.hypot(nodes[n].x - A.x, nodes[n].y - A.y);
            if (d > 2 && d < 30 && (!best || d < best.d)) best = { n, d, cls: t.info.cls };
          }
        }
      }
      if (!best) continue;
      const key = Math.min(s.a, best.n) + '-' + Math.max(s.a, best.n);
      if (done.has(key)) continue;
      done.add(key);
      const pen = Math.max(CROSS_PENALTY[s.info.cls], CROSS_PENALTY[best.cls] || 0);
      // len is the routing cost; m is what the rider actually walks
      const len = best.d + pen;
      nodes[s.a].adj.push({ to: best.n, len, m: best.d, seg: CROSS });
      nodes[best.n].adj.push({ to: s.a, len, m: best.d, seg: CROSS });
    }
  }

  // Dijkstra over walkable edges, up to `budget` meters. Starts at the nearest point a car can stop on (Snapp's pin is
  // a pickup point), so a pin next to a park path or a highway still starts on the street network; falls back to the
  // nearest walkable node. dist is the routing cost (crossing a divided road adds a penalty); walked is the real
  // distance on foot, from the pin itself.
  function walkFrom(g, from, budget) {
    const [sx, sy] = g.pr.xy(from.lng, from.lat);
    let start = -1, snap = Infinity;
    for (const [want, limit] of [['stop', 150], ['walk', 60]]) {
      snap = limit;
      g.nodes.forEach((n, i) => {
        if (want === 'stop' ? n.stop < 0 || !n.walk : !n.walk) return;
        const d = Math.hypot(n.x - sx, n.y - sy);
        if (d < snap) { snap = d; start = i; }
      });
      if (start >= 0) break;
    }
    const N = g.nodes.length;
    const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), crossed = new Uint8Array(N);
    const walked = new Float64Array(N).fill(Infinity);
    if (start < 0) return { start, snap: Infinity, dist, walked, prev, crossed };
    dist[start] = 0;
    walked[start] = snap;
    const heap = [[0, start]];
    const push = (item) => {
      heap.push(item);
      let i = heap.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    while (heap.length) {
      const [d, u] = pop();
      if (d > dist[u] || d > budget) continue;
      for (const e of g.nodes[u].adj) {
        if (e.seg >= 0 && !g.segs[e.seg].info.walk) continue;
        const nd = d + e.len;
        if (nd < dist[e.to]) {
          dist[e.to] = nd;
          walked[e.to] = walked[u] + (e.m != null ? e.m : e.len);
          prev[e.to] = u;
          crossed[e.to] = crossed[u] || (e.seg === CROSS ? 1 : 0);
          push([nd, e.to]);
        }
      }
    }
    return { start, snap, dist, walked, prev, crossed };
  }

  function pathTo(g, w, id) {
    const out = [];
    for (let i = id; i >= 0; i = w.prev[i]) out.push(g.pr.ll(g.nodes[i].x, g.nodes[i].y));
    return out.reverse();
  }

  function toCandidate(g, w, id, kind) {
    const n = g.nodes[id], S = g.nodes[w.start], seg = g.segs[n.stop];
    const ll = g.pr.ll(n.x, n.y);
    return {
      kind, node: id, lat: ll.lat, lng: ll.lng,
      walk: Math.round(w.walked[id]), // from the pin, which may sit off the road (a square, a courtyard)
      crossed: !!w.crossed[id],
      street: seg ? seg.info.name : '',
      cls: seg ? seg.info.cls : '',
      dir: direction(n.x - S.x, n.y - S.y),
      path: pathTo(g, w, id),
    };
  }

  // Up to `max` stop points within budget, nearest first: the walking range is split into rings and each ring
  // gets two points as far apart as possible, so near and far options are both covered. Always includes the
  // far side of a divided road when it is reachable.
  function pickCandidates(g, w, budget, max) {
    const MIN_GAP = 20, NEAR = 15;
    const pool = [];
    g.nodes.forEach((n, i) => { if (n.stop >= 0 && w.dist[i] >= NEAR && w.dist[i] <= budget && w.walked[i] <= budget) pool.push(i); });
    if (!pool.length) return [];
    const chosen = [];
    let far = -1;
    for (const i of pool) if (w.crossed[i] && (far < 0 || w.dist[i] < w.dist[far])) far = i;
    if (far >= 0) chosen.push(far);
    const S = g.nodes[w.start];
    const gap = (i) => {
      const n = g.nodes[i];
      let m = Infinity;
      for (const c of chosen) m = Math.min(m, Math.hypot(n.x - g.nodes[c].x, n.y - g.nodes[c].y));
      return m;
    };
    const fill = (list, quota) => {
      for (let k = 0; k < quota && chosen.length < max; k++) {
        let best = -1, bd = MIN_GAP;
        for (const i of list) {
          // first pick with nothing chosen yet: the point farthest from the start along this ring
          const d = chosen.length ? gap(i) : Math.hypot(g.nodes[i].x - S.x, g.nodes[i].y - S.y);
          if (d > bd) { bd = d; best = i; }
        }
        if (best < 0) return;
        chosen.push(best);
      }
    };
    const rings = Math.max(1, Math.ceil(max / 2));
    for (let r = 0; r < rings; r++) {
      const lo = NEAR + ((budget - NEAR) * r) / rings, hi = NEAR + ((budget - NEAR) * (r + 1)) / rings;
      const ring = pool.filter((i) => w.dist[i] >= lo && w.dist[i] <= hi);
      const have = chosen.filter((i) => w.dist[i] >= lo && w.dist[i] <= hi).length;
      fill(ring, 2 - have);
    }
    fill(pool, max); // rings that had too few roads leave room for more elsewhere
    return chosen.sort((a, b) => w.walked[a] - w.walked[b]); // nearest first, in real meters
  }

  // Up to `max` new points 12–35 m around a good one, spread apart and away from anything already quoted
  // (12 m clears Snapp's ~6 m price lock), on the same side of the road and inside the walking budget.
  function refineAround(g, w, id, budget, quoted, max) {
    const c = g.nodes[id], out = [];
    const far = (i, list, m) => list.every((j) => Math.hypot(g.nodes[i].x - g.nodes[j].x, g.nodes[i].y - g.nodes[j].y) >= m);
    const pool = [];
    g.nodes.forEach((n, i) => {
      const d = Math.hypot(n.x - c.x, n.y - c.y);
      if (n.stop >= 0 && d >= 12 && d <= 35 && w.walked[i] <= budget && w.crossed[i] === w.crossed[id]) pool.push([i, w.dist[i]]);
    });
    pool.sort((a, b) => a[1] - b[1]); // shorter walks first
    for (const [i] of pool) {
      if (out.length >= (max || 2)) break;
      if (far(i, quoted, 10) && far(i, out, 15)) out.push(i);
    }
    return out;
  }

  // Fallback when no road data: plain grid, straight-line distance.
  function gridCandidates(center, R, step, kind) {
    const pr = projector(center), out = [];
    const k = Math.floor(R / step);
    for (let i = -k; i <= k; i++) for (let j = -k; j <= k; j++) {
      const x = j * step, y = i * step, d = Math.hypot(x, y);
      if (!d || d > R + 0.001) continue;
      const ll = pr.ll(x, y);
      out.push({ kind, lat: ll.lat, lng: ll.lng, walk: Math.round(d), crossed: false, street: '', cls: '', dir: direction(x, y), path: [center, ll], approx: true });
    }
    return out.sort((a, b) => a.walk - b.walk);
  }

  /* ---------------- Snapp price API ---------------- */
  function priceBody(points, category) {
    return {
      points: points.map((p) => ({ lat: String(p.lat), lng: String(p.lng) })),
      price_ride_recom: false, options: {}, locale: 'fa-IR', os: 6, version: 0,
      categories: [category || 1], voucher_code: '', flexi_step: 0,
    };
  }
  function parsePrices(json) {
    const prices = {}, names = {};
    for (const s of (json && json.data && json.data.services) || []) {
      const id = s.id != null ? s.id : s.service_type;
      if (s.info && s.info.name) names[id] = s.info.name;
      if (s.enabled !== false && s.price && s.price.final > 0) prices[id] = s.price.final;
    }
    // categories offered on this route, e.g. [{ id: 1, name }, { id: 2, name }] for car and motorbike
    const categories = ((json && json.data && json.data.categories) || []).map((c) => ({ id: c.id, name: c.name }));
    return { prices, names, ttl: json && json.data && json.data.ttl, categories };
  }

  /* ---------------- search ---------------- */
  class SearchError extends Error { constructor(code) { super(code); this.code = code; } }
  const priceOf = (c, sid) => (c && c.prices && c.prices[sid]) || Infinity;

  /*
   * opts:
   *   route: { points: [{lat,lng}, ...], category }
   *   budget: walking meters (same for origin and destination)
   *   quote(points) → Promise<{ prices: {serviceId: rial}, names }>   (only network call besides getFeatures)
   *   getFeatures(center, R) → Promise<features[]>   (may resolve [])
   *   serviceId (optional), maxRequests (25), perEnd (8), delay (250 ms)
   *   onProgress(result), isCancelled()
   */
  async function search(opts) {
    const route = opts.route, pts = route.points, last = pts.length - 1;
    const budget = opts.budget, maxReq = opts.maxRequests || 25, perEnd = opts.perEnd || 8;
    const delay = opts.delay == null ? 250 : opts.delay;
    const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const progress = opts.onProgress || (() => {});
    const cancelled = opts.isCancelled || (() => false);

    const res = {
      at: Date.now(), budget, category: route.category || 1, routePoints: pts,
      O: pts[0], D: pts[last], base: null, baseEnd: null, origins: [], dests: [], combo: null,
      names: {}, sid: opts.serviceId, requests: 0, planned: 0, drift: 0, approx: { origin: false, dest: false },
    };

    // road graphs first, so the plan (request count) is known before quoting
    async function plan(center, kind) {
      let feats = [];
      try { feats = (await opts.getFeatures(center, budget + 80)) || []; } catch (e) { feats = []; }
      const g = feats.length ? buildGraph(feats, center, budget) : null;
      const w = g ? walkFrom(g, center, budget) : null;
      if (!g || w.start < 0) {
        res.approx[kind] = true;
        const step = Math.max(40, Math.round(budget / 3));
        return { g: null, w: null, cands: gridCandidates(center, budget, step, kind).slice(0, perEnd) };
      }
      return { g, w, cands: pickCandidates(g, w, budget, perEnd).map((id) => toCandidate(g, w, id, kind)) };
    }
    const po = await plan(res.O, 'origin');
    const pd = await plan(res.D, 'dest');
    res.planned = maxReq;
    res.graphs = { origin: po, dest: pd };
    progress(res);

    // Snapp locks a quote for a few minutes per route (points within ~6 m share the lock). `ttl` is the lock's seconds
    // left, so a ttl well below the freshest one seen means the price was fixed earlier.
    let lastTtl = null;
    async function ask(points) {
      if (cancelled()) throw new SearchError('cancel');
      if (res.requests >= maxReq) throw new SearchError('budget');
      if (res.requests) await sleep(delay);
      if (cancelled()) throw new SearchError('cancel');
      res.requests++;
      const q = await opts.quote(points);
      Object.assign(res.names, q.names);
      lastTtl = q.ttl == null ? null : q.ttl;
      if (lastTtl != null) res.freshTtl = Math.max(res.freshTtl || 0, lastTtl);
      return q.prices;
    }
    const withPoint = (c, kind, base) => {
      const p = (base || pts).slice();
      p[kind === 'origin' ? 0 : last] = { lat: c.lat, lng: c.lng };
      return p;
    };
    const sid = () => res.sid;
    const reserve = 3; // keep room for a fresh twin of the base, the combo and the final base
    const left = () => maxReq - reserve - res.requests;
    const saving = (c) => priceOf(res.base, sid()) - priceOf(c, sid());

    async function quoteCand(c, kind, list) {
      c.prices = await ask(withPoint(c, kind));
      list.push(c);
      progress(res);
    }
    // Phase 1: a spread of points around each end.
    async function explore(p, kind, list) {
      for (const c of p.cands) {
        if (left() <= 0) break;
        await quoteCand(c, kind, list);
      }
    }
    // Phase 2: spend what is left where it pays. Prices change in patches (one side of a junction, one stretch of a
    // boulevard), so keep stepping around the best point found so far, on whichever end is currently winning.
    async function refine() {
      const ends = [[po, 'origin', res.origins], [pd, 'dest', res.dests]].filter(([p]) => p.g);
      const tried = new Set();
      while (left() > 0) {
        let pick = null;
        for (const [p, kind, list] of ends) {
          for (const c of list) {
            if (c.node == null || tried.has(c) || !isFinite(priceOf(c, sid())) || saving(c) < MIN_SAVING) continue;
            if (!pick || saving(c) > saving(pick.c) || (saving(c) === saving(pick.c) && c.walk < pick.c.walk)) pick = { p, kind, list, c };
          }
        }
        if (!pick) return;
        tried.add(pick.c);
        const ids = refineAround(pick.p.g, pick.p.w, pick.c.node, budget, pick.list.filter((c) => c.node != null).map((c) => c.node), Math.min(3, left()));
        for (const id of ids) {
          if (left() <= 0) break;
          const c = toCandidate(pick.p.g, pick.p.w, id, pick.kind);
          c.refined = true;
          await quoteCand(c, pick.kind, pick.list);
        }
      }
    }

    // A point 12–25 m from the origin on the same side: same street, but outside the base's price lock.
    function twinOf(p) {
      if (p.g) {
        let best = -1;
        p.g.nodes.forEach((n, i) => {
          const d = p.w.dist[i];
          if (n.stop >= 0 && !p.w.crossed[i] && d >= 12 && d <= 25 && (best < 0 || Math.abs(d - 15) < Math.abs(p.w.dist[best] - 15))) best = i;
        });
        if (best >= 0) return toCandidate(p.g, p.w, best, 'origin');
      }
      const ll = projector(res.O).ll(0, 15);
      return { kind: 'origin', lat: ll.lat, lng: ll.lng, walk: 15, crossed: false, street: '', cls: '', dir: 'شمال', path: [res.O, ll], approx: true };
    }

    try {
      res.base = { kind: 'base', lat: res.O.lat, lng: res.O.lng, walk: 0, prices: await ask(pts) };
      res.base.ttl = lastTtl;
      const ids = Object.keys(res.base.prices).map(Number);
      if (!ids.length) throw new SearchError('noprice');
      if (!res.base.prices[res.sid]) res.sid = ids[0];
      progress(res);
      await explore(po, 'origin', res.origins);
      await explore(pd, 'dest', res.dests);
      await refine();
      // the base price was locked before this search started: also price the same street right now
      if (res.base.ttl != null && res.freshTtl - res.base.ttl > 45 && res.requests < maxReq - 1) {
        const t = twinOf(po);
        t.prices = await ask(withPoint(t, 'origin'));
        t.twin = true;
        res.twin = t;
        res.origins.push(t);
        progress(res);
      }
      if (res.base.ttl != null && res.freshTtl - res.base.ttl > 45) res.baseLock = { left: res.base.ttl, at: res.at };
      const bo = bestOf(res.origins, sid()), bd = bestOf(res.dests, sid());
      const bp = priceOf(res.base, sid());
      if (bo && bd && bp - priceOf(bo, sid()) >= MIN_SAVING && bp - priceOf(bd, sid()) >= MIN_SAVING) {
        const p = pts.slice();
        p[0] = { lat: bo.lat, lng: bo.lng };
        p[last] = { lat: bd.lat, lng: bd.lng };
        res.combo = { kind: 'both', origin: bo, dest: bd, walk: bo.walk + bd.walk, prices: await ask(p) };
        progress(res);
      }
      if (res.requests > 1 && res.requests < maxReq) {
        res.baseEnd = { prices: await ask(pts) };
        res.drift = priceOf(res.baseEnd, sid()) - bp;
      }
    } catch (e) {
      res.error = e.code || 'unknown';
      if (!e.code) res.exception = e;
    }
    res.done = true;
    progress(res);
    return res;
  }

  function bestOf(list, sid) {
    let b = null;
    for (const c of list) if (priceOf(c, sid) < priceOf(b, sid) || (b && priceOf(c, sid) === priceOf(b, sid) && c.walk < b.walk)) b = c;
    return b && isFinite(priceOf(b, sid)) ? b : null;
  }

  /*
   * Result cards: Pareto frontier over (walk, price) of single changes (origin or destination) plus the combo when it
   * beats every single change. At most `max` cards: nearest saving, balanced, cheapest.
   */
  function cards(res, sid, max) {
    max = max || 3;
    if (sid == null) sid = res.sid;
    const bp = priceOf(res.base, sid);
    if (!isFinite(bp)) return [];
    const ok = (c) => !c.dismissed && bp - priceOf(c, sid) >= MIN_SAVING;
    const all = res.origins.concat(res.dests).filter(ok);
    if (res.combo && ok(res.combo) && all.every((c) => priceOf(res.combo, sid) < priceOf(c, sid))) all.push(res.combo);
    all.sort((a, b) => a.walk - b.walk || priceOf(a, sid) - priceOf(b, sid));
    const front = [];
    let low = Infinity;
    for (const c of all) { const p = priceOf(c, sid); if (p < low) { front.push(c); low = p; } }
    let pick = front;
    if (front.length > max) {
      const mid = front.slice(1, -1).sort((a, b) => (bp - priceOf(b, sid)) / (b.walk + 20) - (bp - priceOf(a, sid)) / (a.walk + 20));
      pick = [front[0]].concat(mid.slice(0, max - 2), [front[front.length - 1]]).sort((a, b) => a.walk - b.walk);
    }
    return pick.map((c, i) => ({
      c, price: priceOf(c, sid), saving: bp - priceOf(c, sid), base: bp,
      tag: pick.length === 1 ? 'best' : i === 0 ? 'nearest' : i === pick.length - 1 ? 'cheapest' : 'balanced',
    }));
  }

  // Closest quoted point when nothing is under the cap.
  function nearestToCap(res, sid) {
    const list = res.origins.concat(res.dests).filter((c) => isFinite(priceOf(c, sid)));
    return list.sort((a, b) => priceOf(a, sid) - priceOf(b, sid) || a.walk - b.walk)[0] || null;
  }

  // Normalize Persian label text: drop kashida (U+0640) and ZWNJ, map hamza alef forms to plain alef, Arabic yeh and kaf to Persian.
  const normalizeFa = (s) => String(s || '').replace(/[ـ‌]/g, '').replace(/[أإآ]/g, 'ا').replace(/ي/g, 'ی').replace(/ك/g, 'ک');

  return {
    MIN_SAVING, distance, projector, direction, tileOf, tilesAround, decodeTile, edgeInfo, buildGraph, walkFrom,
    pickCandidates, refineAround, toCandidate, gridCandidates, priceBody, parsePrices, search, cards, priceOf,
    bestOf, nearestToCap, normalizeFa, SearchError,
  };
});
