// Unit tests for src/core.js. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');

const center = { lat: 35.7, lng: 51.4 };
const pr = C.projector(center);
const ll = (x, y) => { const p = pr.ll(x, y); return [p.lng, p.lat]; };
const line = (pts) => pts.map(([x, y]) => ll(x, y));

// A divided boulevard (two one-way carriageways 12 m apart), a side street on each side, and a trunk road.
const features = [
  { props: { class: 'primary', name: 'بلوار', oneway: 1, osm_id: 1 }, lines: [line([[-300, 6], [50, 6], [300, 6]])] },
  { props: { class: 'primary', name: 'بلوار', oneway: 1, osm_id: 2 }, lines: [line([[300, -6], [-80, -6], [-300, -6]])] },
  { props: { class: 'minor', name: 'شمالی', oneway: 0, osm_id: 3 }, lines: [line([[50, 6], [50, 200]])] },
  { props: { class: 'minor', name: 'جنوبی', oneway: 0, osm_id: 4 }, lines: [line([[-80, -6], [-80, -100]])] },
  { props: { class: 'trunk', name: 'اتوبان', oneway: 0, osm_id: 5 }, lines: [line([[-300, -100], [-80, -100], [300, -100]])] },
  { props: { class: 'primary', name: 'رمپ', oneway: 1, ramp: 1, osm_id: 6 }, lines: [line([[100, -100], [100, -20]])] },
];
const start = pr.ll(0, 6);

test('edgeInfo: trunk and ramps are neither walkable nor stoppable', () => {
  assert.deepEqual([C.edgeInfo({ class: 'trunk' }).walk, C.edgeInfo({ class: 'trunk' }).stop], [false, false]);
  assert.equal(C.edgeInfo({ class: 'primary', ramp: 1 }).stop, false);
  assert.equal(C.edgeInfo({ class: 'minor', brunnel: 'tunnel' }).walk, false);
  assert.equal(C.edgeInfo({ class: 'path' }).stop, false);
  assert.equal(C.edgeInfo({ class: 'path' }).walk, true);
  assert.equal(C.edgeInfo({ class: 'minor' }).stop, true);
});

test('walking graph crosses a divided boulevard with a penalty', () => {
  const g = C.buildGraph(features, center, 200);
  const w = C.walkFrom(g, start, 200);
  assert.ok(w.start >= 0 && w.snap < 1);
  const nearest = (x, y) => g.nodes.map((n, i) => [i, Math.hypot(n.x - x, n.y - y)]).sort((a, b) => a[1] - b[1])[0][0];
  const far = nearest(0, -6);
  assert.equal(w.crossed[far], 1);
  assert.ok(w.dist[far] >= 30 && w.dist[far] <= 40, 'cross cost ≈ 12 m + 20 m, got ' + w.dist[far]);
  // walking along the near side is plain distance
  const along = nearest(40, 6);
  assert.ok(Math.abs(w.dist[along] - Math.abs(g.nodes[along].x)) < 0.5);
  // the side street on the far side is reached through the crossing
  assert.equal(w.crossed[nearest(-80, -50)], 1);
  // the trunk is never walked on
  assert.equal(w.dist[nearest(200, -100)], Infinity);
});

test('a pin on a park path or next to a highway starts on the nearest street', () => {
  const extra = features.concat([
    { props: { class: 'path', subclass: 'footway', osm_id: 7 }, lines: [line([[0, 30], [0, 60], [30, 60]])] }, // park, not connected
  ]);
  const g = C.buildGraph(extra, center, 150);
  const w = C.walkFrom(g, pr.ll(2, 32), 150); // pin right on the park path, 26 m from the boulevard
  assert.ok(g.nodes[w.start].stop >= 0, 'starts on a stoppable road');
  assert.ok(C.pickCandidates(g, w, 150, 8).length >= 5);
  const g2 = C.buildGraph(features, center, 150);
  const h = C.walkFrom(g2, pr.ll(-60, -100), 150); // pin on the trunk, 20 m from the side street
  assert.ok(h.start >= 0 && g2.segs[g2.nodes[h.start].stop].info.cls === 'minor');
  const ids = C.pickCandidates(g, w, 150, 8);
  assert.ok(w.snap > 20);
  for (const id of ids) assert.ok(C.toCandidate(g, w, id, 'origin').walk >= w.snap, 'walk counts the way from the pin to the road');
});

test('the walk shown is the real distance on foot, not the crossing cost', () => {
  const g = C.buildGraph(features, center, 200);
  const w = C.walkFrom(g, start, 200);
  const nearest = (x, y) => g.nodes.map((n, i) => [i, Math.hypot(n.x - x, n.y - y)]).sort((a, b) => a[1] - b[1])[0][0];
  // 12 m straight across the boulevard: routing pays the 20 m penalty, the rider walks 12 m
  const far = nearest(0, -6);
  assert.ok(w.dist[far] >= 30, 'cost keeps the penalty');
  assert.equal(C.toCandidate(g, w, far, 'dest').walk, 12);
  // across, 80 m along the far side, then down the side street
  const side = nearest(-80, -56);
  assert.equal(C.toCandidate(g, w, side, 'dest').walk, Math.round(12 + 80 + (-6 - g.nodes[side].y)));
});

test('the walk shown, pin to road included, stays within the budget', () => {
  const g = C.buildGraph(features, center, 100);
  const w = C.walkFrom(g, pr.ll(0, 36), 100); // pin 30 m off the boulevard
  assert.ok(w.snap > 29 && w.snap < 31);
  const cands = C.pickCandidates(g, w, 100, 8).map((id) => C.toCandidate(g, w, id, 'origin'));
  assert.ok(cands.length > 0);
  for (const c of cands) assert.ok(c.walk <= 100, 'walk ' + c.walk + ' is over the 100 m budget');
});

test('a side street that stops 2 m short of the road (dropped T-junction vertex) is still connected', () => {
  const gap = [
    { props: { class: 'secondary', name: 'اصلی', oneway: 0, osm_id: 10 }, lines: [line([[-200, 0], [200, 0]])] },
    { props: { class: 'minor', name: 'فرعی', oneway: 0, osm_id: 11 }, lines: [line([[33, 2], [33, 150]])] },
  ];
  const g = C.buildGraph(gap, center, 200);
  const w = C.walkFrom(g, pr.ll(-100, 0), 300);
  const far = g.nodes.map((n, i) => [i, Math.hypot(n.x - 33, n.y - 140)]).sort((a, b) => a[1] - b[1])[0][0];
  assert.ok(isFinite(w.dist[far]), 'reachable through the join');
  assert.ok(Math.abs(w.dist[far] - (133 + 140)) < 6, 'about 133 m along + 140 m up, got ' + w.dist[far]);
  assert.equal(w.crossed[far], 0, 'a join is not a road crossing');
});

test('candidates: on stoppable roads only, spread, far side included, nearest first', () => {
  const g = C.buildGraph(features, center, 150);
  const w = C.walkFrom(g, start, 150);
  const ids = C.pickCandidates(g, w, 150, 8);
  assert.ok(ids.length >= 5 && ids.length <= 8);
  const cands = ids.map((id) => C.toCandidate(g, w, id, 'dest'));
  for (const c of cands) {
    assert.ok(['primary', 'minor'].includes(c.cls), 'class ' + c.cls);
    assert.ok(c.walk >= 10 && c.walk <= 150); // 12 m straight across the boulevard is the nearest
  }
  assert.ok(cands.some((c) => c.crossed), 'far side present');
  assert.ok(cands.filter((c) => c.walk <= 50).length >= 2, 'near options covered, not only far ones');
  assert.ok(cands.some((c) => c.walk >= 110), 'far options covered');
  for (let i = 1; i < cands.length; i++) assert.ok(cands[i].walk >= cands[i - 1].walk);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = g.nodes[ids[i]], b = g.nodes[ids[j]];
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 20);
  }
  assert.ok(cands[0].path.length >= 2);
});

// ---- minimal MVT encoder for the decoder test ----
function varint(n, out) { while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); } out.push(n); }
function field(num, wt, out) { varint(num * 8 + wt, out); }
function bytesField(num, bytes, out) { field(num, 2, out); varint(bytes.length, out); out.push(...bytes); }
const str = (s) => Array.from(Buffer.from(s, 'utf8'));
const zz = (n) => (n << 1) ^ (n >> 31);
function packedField(num, arr, out) { const b = []; arr.forEach((v) => varint(v, b)); bytesField(num, b, out); }

test('decodeTile reads line features and properties', () => {
  const val1 = []; bytesField(1, str('primary'), val1);
  const val2 = []; field(5, 0, val2); varint(1, val2);
  const val3 = []; bytesField(1, str('بلوار ولی عصر'), val3);
  const feat = [];
  field(3, 0, feat); varint(2, feat);
  packedField(2, [0, 0, 1, 1, 2, 2], feat);
  packedField(4, [9, zz(100), zz(200), 10, zz(50), zz(0)], feat);
  const pt = []; field(3, 0, pt); varint(1, pt); packedField(4, [9, zz(5), zz(5)], pt); // point: ignored
  const layer = [];
  field(15, 0, layer); varint(2, layer);
  bytesField(1, str('transportation'), layer);
  bytesField(2, feat, layer);
  bytesField(2, pt, layer);
  ['class', 'oneway', 'name'].forEach((k) => bytesField(3, str(k), layer));
  [val1, val2, val3].forEach((v) => bytesField(4, v, layer));
  field(5, 0, layer); varint(4096, layer);
  const other = []; bytesField(1, str('water'), other);
  const tile = []; bytesField(3, other, tile); bytesField(3, layer, tile);

  const t = { z: 14, x: 10532, y: 6458 };
  const out = C.decodeTile(new Uint8Array(tile), t);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].props, { class: 'primary', oneway: 1, name: 'بلوار ولی عصر' });
  const n = 2 ** 14;
  const lng = (px) => ((t.x + px / 4096) / n) * 360 - 180;
  assert.equal(out[0].lines[0].length, 2);
  assert.ok(Math.abs(out[0].lines[0][0][0] - lng(100)) < 1e-9);
  assert.ok(Math.abs(out[0].lines[0][1][0] - lng(150)) < 1e-9);
  assert.equal(out[0].lines[0][0][1], out[0].lines[0][1][1]);
  const tt = C.tileOf(out[0].lines[0][0][0], out[0].lines[0][0][1], 14);
  assert.deepEqual([tt.x, tt.y], [t.x, t.y]);
});

test('tilesAround covers neighbours near a tile edge', () => {
  const t = C.tileOf(center.lng, center.lat, 14);
  const list = C.tilesAround(center, 300);
  assert.ok(list.some((a) => a.x === t.x && a.y === t.y));
  assert.ok(list.length >= 1 && list.length <= 4);
});

// ---- search with a fake price function ----
function fakeQuote(log) {
  // destination on the far side (y < 0) is 20,000 rial cheaper; moving the origin north is 30,000 cheaper per 100 m.
  return async (points) => {
    log.push(points);
    const o = pr.xy(points[0].lng, points[0].lat), d = pr.xy(points[points.length - 1].lng, points[points.length - 1].lat);
    let p = 800000;
    if (d[1] < -1) p -= 20000;
    p -= Math.round(Math.max(0, o[1] - 6) / 100 * 30) * 1000;
    return { prices: { 1: p, 2: p + 200000 }, names: { 1: 'اسنپ', 2: 'اکوپلاس' } };
  };
}

test('search: stays within budget, finds far side and better origin, re-quotes base', async () => {
  const log = [];
  const res = await C.search({
    route: { points: [start, start], category: 1 }, budget: 150, delay: 0,
    quote: fakeQuote(log), getFeatures: async () => features,
  });
  assert.equal(res.error, undefined);
  assert.ok(res.requests <= 25 && res.requests === log.length);
  assert.ok(res.baseEnd && res.drift === 0);
  assert.equal(res.sid, 1);
  const cs = C.cards(res, 1);
  assert.ok(cs.length >= 1 && cs.length <= 3);
  assert.ok(cs.some((k) => k.c.kind === 'dest' && k.c.crossed && k.saving === 20000));
  assert.ok(cs.some((k) => k.c.kind === 'origin' && k.saving > 0));
  for (let i = 1; i < cs.length; i++) {
    assert.ok(cs[i].c.walk >= cs[i - 1].c.walk);
    assert.ok(cs[i].price < cs[i - 1].price, 'frontier: farther must be cheaper');
  }
});

test('search: a base locked earlier gets a fresh twin on the same street', async () => {
  let n = 0;
  const base = fakeQuote([]);
  const quote = async (points) => {
    const q = await base(points);
    // The page locked the base price earlier (100 s left); every new quote is fresh (360 s).
    // Prices went up since the lock: fresh quotes are 30,000 rial higher.
    const first = n++ === 0;
    if (!first) for (const k in q.prices) q.prices[k] += 30000;
    return Object.assign(q, { ttl: first ? 100 : 360 });
  };
  const res = await C.search({ route: { points: [start, start] }, budget: 150, delay: 0, quote, getFeatures: async () => features });
  assert.ok(res.baseLock && res.baseLock.left === 100);
  assert.ok(res.twin && res.twin.walk >= 12 && res.twin.walk <= 25 && !res.twin.crossed);
  assert.equal(C.priceOf(res.twin, 1) - C.priceOf(res.base, 1), 30000);
  assert.ok(res.requests <= 25);

  const fresh = await C.search({ route: { points: [start, start] }, budget: 150, delay: 0, getFeatures: async () => features,
    quote: async (p) => Object.assign(await base(p), { ttl: 360 }) });
  assert.equal(fresh.twin, undefined);
  assert.equal(fresh.baseLock, undefined);
});

test('search: a route with a stop in the middle only moves the first and last points', async () => {
  const stop = pr.ll(40, 150);
  const seen = [];
  const res = await C.search({
    route: { points: [start, stop, start], category: 1 }, budget: 150, delay: 0,
    getFeatures: async () => features,
    quote: async (points) => { seen.push(points); return fakeQuote([])([points[0], points[2]]); },
  });
  assert.equal(res.error, undefined);
  assert.ok(seen.length > 5);
  for (const p of seen) {
    assert.equal(p.length, 3);
    assert.deepEqual(p[1], stop, 'the middle stop is never moved');
  }
  assert.ok(res.dests.length > 0 && res.dests.every((c) => c.kind === 'dest'));
});

test('search: no road data falls back to a grid', async () => {
  const res = await C.search({
    route: { points: [start, start], category: 1 }, budget: 150, delay: 0,
    quote: fakeQuote([]), getFeatures: async () => [],
  });
  assert.ok(res.approx.origin && res.approx.dest);
  assert.ok(res.origins.length > 0 && res.origins.every((c) => c.approx));
});

test('search: 401 style errors surface as codes', async () => {
  const res = await C.search({
    route: { points: [start, start] }, budget: 100, delay: 0, getFeatures: async () => features,
    quote: async () => { throw new C.SearchError('auth'); },
  });
  assert.equal(res.error, 'auth');
});

test('cards: Pareto frontier, dismissed and tiny savings hidden', () => {
  const mk = (walk, p, kind = 'dest') => ({ kind, walk, prices: { 1: p } });
  const res = {
    sid: 1, base: { prices: { 1: 800000 } }, combo: null,
    origins: [mk(30, 795000, 'origin')],                   // 500 toman saving: below MIN_SAVING
    dests: [mk(20, 790000), mk(40, 790000), mk(60, 770000), mk(80, 780000), mk(100, 760000), mk(150, 740000)],
  };
  const cs = C.cards(res, 1);
  assert.deepEqual(cs.map((k) => k.c.walk), [20, 60, 150]);
  assert.deepEqual(cs.map((k) => k.tag), ['nearest', 'balanced', 'cheapest']);
  res.dests[0].dismissed = true;
  assert.equal(C.cards(res, 1)[0].c.walk, 40); // the equal-price point behind it moves up
});

test('normalizeFa matches Snapp label spellings', () => {
  assert.equal(C.normalizeFa('مبـدأ: خونه').startsWith('مبدا'), true);
  assert.equal(C.normalizeFa('مقصد'), 'مقصد');
});

test('parsePrices reads enabled services in rial', () => {
  const q = C.parsePrices({ data: { ttl: 290, services: [
    { id: 1, enabled: true, info: { name: 'اسنپ' }, price: { final: 810000 } },
    { id: 2, enabled: false, info: { name: 'اکوپلاس' }, price: { final: 1050000 } },
  ] } });
  assert.deepEqual(q.prices, { 1: 810000 });
  assert.equal(q.names[2], 'اکوپلاس');
  assert.equal(q.ttl, 290);
});
