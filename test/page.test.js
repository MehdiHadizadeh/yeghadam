// Tests for the page layer (src/ui.js) where it talks to the service: price requests, their errors and the per-account
// limits. The script runs in a sandbox that stands in for app.snapp.taxi with a fake fetch and no DOM. Timers run 1000
// times faster, so a 15 s request timeout takes 15 ms. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = ['core.js', 'ui.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
const ROUTE = [{ lat: 35.7, lng: 51.4 }, { lat: 35.71, lng: 51.41 }];
const OK = { data: { services: [{ id: 1, enabled: true, price: { final: 850000 }, info: { name: 'اسنپ' } }] } };

function storage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

// fetchImpl(url, init) is the network; `stored` is what the page's settings held before it loaded. Returns the sandbox
// (the page's window) and a log of requests.
// native: an object to stand in for the Android bridge (YeghadamNative), when given.
function page(fetchImpl, noAbort, stored, native) {
  const requests = [];
  const noop = () => {};
  const w = {
    location: { hostname: 'app.snapp.taxi', origin: 'https://app.snapp.taxi', pathname: '/', search: '' },
    localStorage: storage(), sessionStorage: storage(),
    document: { addEventListener: noop, querySelectorAll: () => [], querySelector: () => null, body: null, contains: () => false, visibilityState: 'visible' },
    navigator: { appVersion: '5.0' }, matchMedia: () => ({ matches: true }), history: {}, innerWidth: 400, innerHeight: 800,
    addEventListener: noop, postMessage: noop, console: { warn: noop, error: noop, log: noop },
    setTimeout: (f, ms) => setTimeout(f, (ms || 0) / 1000), clearTimeout, setInterval: () => 0, clearInterval: noop,
    AbortController, TextDecoder, URLSearchParams,
    XMLHttpRequest: function () {},
    fetch: (url, init) => { requests.push({ url, init }); return fetchImpl(url, init); },
  };
  if (noAbort) delete w.AbortController; // old Android WebViews (before Chrome 66)
  w.window = w; w.self = w;
  w.localStorage.setItem('accessToken', 'test-token');
  w.localStorage.setItem('yeghadam:consent', JSON.stringify({ v: 1 }));
  if (stored) w.localStorage.setItem('yeghadam:settings', JSON.stringify(stored));
  if (native) w.YeghadamNative = native;
  vm.runInNewContext(SOURCE, w);
  return { w, requests, usage: () => JSON.parse(w.localStorage.getItem('yeghadam:usage') || '{}') };
}
const answer = (body, status) => Promise.resolve({
  ok: (status || 200) < 300, status: status || 200, text: async () => JSON.stringify(body), json: async () => body,
});
// a request that never gets an answer until it is aborted
const stall = (url, init) => new Promise((_, reject) => {
  if (init.signal) init.signal.addEventListener('abort', () => reject(new Error('aborted')));
});
const plain = (v) => JSON.parse(JSON.stringify(v));

test('the other service gets this page\'s car price for a route', async () => {
  const p = page(() => answer(OK));
  assert.deepEqual(plain(await p.w.__yeghadamPeerQuote(ROUTE)), { status: 'ok', price: 850000 });
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0].init.headers.authorization, 'Bearer test-token');
});

test('a request with no answer times out and reads as no price, without the rate-limit pause', { timeout: 10000 }, async () => {
  const p = page(stall);
  assert.deepEqual(plain(await p.w.__yeghadamPeerQuote(ROUTE)), { status: 'none' });
  assert.equal(p.requests.length, 2, 'two attempts, each ended by the timeout, inside the other page\'s 40 s wait');
  assert.equal((p.usage().cool || []).length, 0);
});

test('a 429 is never retried: one request, then new searches pause', async () => {
  const p = page(() => answer({}, 429));
  assert.deepEqual(plain(await p.w.__yeghadamPeerQuote(ROUTE)), { status: 'none' });
  assert.equal(p.requests.length, 1);
  assert.equal(p.usage().cool.length, 1);
  const q = page((url) => (url.includes('/api/v3/price') ? answer({}, 429) : Promise.reject(new Error('no tiles'))));
  const dbg = q.w.__yeghadamDebug;
  dbg.state.route = { points: ROUTE, category: 1, t: 0 };
  await dbg.run();
  assert.equal(dbg.state.error, 'rate');
  assert.equal(q.requests.filter((r) => r.url.includes('/api/v3/price')).length, 1);
});

test('retries count against the search: requests stay within the quote cap plus six', { timeout: 20000 }, async () => {
  let n = 0; // every other request fails, so each quote takes two
  const p = page((url) => (url.includes('/api/v3/price') ? (n++ % 2 ? answer(OK) : answer({}, 503)) : Promise.reject(new Error('no tiles'))));
  const dbg = p.w.__yeghadamDebug;
  dbg.state.route = { points: ROUTE, category: 1, t: 0 };
  await dbg.run();
  const sent = p.requests.filter((r) => r.url.includes('/api/v3/price')).length;
  assert.ok(sent <= 25 + 6, `sent ${sent}`);
  assert.equal(dbg.state.error, 'network');
  assert.ok(dbg.state.result.base, 'what was found before the cap stays');
  assert.equal(dbg.state.sends, null);
});

test('map tiles that never answer do not hold up the search', { timeout: 10000 }, async () => {
  const p = page((url, init) => (url.includes('/api/v3/price') ? answer(OK) : stall(url, init)));
  const dbg = p.w.__yeghadamDebug;
  dbg.state.route = { points: ROUTE, category: 1, t: 0 };
  await dbg.run();
  assert.ok(dbg.state.result.base);
  assert.equal(dbg.state.result.approx.origin, true, 'fell back to straight-line points');
  const tile = p.requests.find((r) => !r.url.includes('/api/v3/price'));
  assert.ok(tile.init.signal.aborted, 'the stalled tile request was aborted');
});

test('a search keeps price and trip-time changes on the device, without places', { timeout: 20000 }, async () => {
  const withEta = { data: { services: [{ id: 1, enabled: true, price: { final: 850000 }, info: { name: 'اسنپ' }, estimation: { eta: [20] } }] } };
  const p = page((url) => (url.includes('/api/v3/price') ? answer(withEta) : Promise.reject(new Error('no tiles'))), false, { depth: 'quick' });
  const dbg = p.w.__yeghadamDebug;
  dbg.state.route = { points: ROUTE, category: 1, t: 0 };
  await dbg.run();
  const stored = p.w.localStorage.getItem('yeghadam:eta');
  const { stats, log } = plain(dbg.eta());
  assert.equal(log.length, 1);
  assert.ok(log[0].rows.length > 0);
  assert.equal(stats.points, log[0].rows.length);
  assert.ok(!/35\.7|51\.4/.test(stored), 'no coordinates stored');
});

test('the fallback pin tap skips controls outside the map, whatever their text', () => {
  const tappable = page(() => answer(OK)).w.__yeghadamDebug.pinTappable;
  const el = (control, text) => ({ closest: () => (control ? { textContent: text || '' } : null) });
  const inside = (c) => ({ contains: () => c });
  assert.equal(tappable(el(false), 100, inside(false)), true, 'a plain element: the pin drawn over the map');
  assert.equal(tappable(el(true, 'ادامه'), 100, inside(false)), false, 'an unknown button outside the map');
  assert.equal(tappable(el(true, 'ادامه'), 100, inside(true)), true, 'a marker button on the map');
  assert.equal(tappable(el(true, 'درخواست اسنپ'), 100, inside(true)), false, 'never a ride action');
  assert.equal(tappable(null, 100, inside(true)), false);
});

test('server errors are not taken for a rate limit; a 429 is, and pauses new searches', async () => {
  const p = page(() => answer({}, 503));
  await p.w.__yeghadamPeerQuote(ROUTE);
  assert.equal((p.usage().cool || []).length, 0);
  const q = page(() => answer({}, 429));
  await q.w.__yeghadamPeerQuote(ROUTE);
  assert.equal(q.usage().cool.length, 1);
});

test('questions from the other service are capped at 20 quotes in 10 minutes', async () => {
  const p = page(() => answer(OK));
  for (let i = 0; i < 20; i++) assert.equal((await p.w.__yeghadamPeerQuote(ROUTE)).status, 'ok');
  assert.deepEqual(plain(await p.w.__yeghadamPeerQuote(ROUTE)), { status: 'none' });
  assert.equal(p.requests.length, 20, 'the 21st question sends nothing');
});

test('route points that are not numbers are refused before any request', async () => {
  const p = page(() => answer(OK));
  for (const points of [[null, null], [{ lat: '', lng: '' }, ROUTE[1]], [{ lat: true, lng: 1 }, ROUTE[1]], ROUTE.slice(0, 1)]) {
    assert.deepEqual(plain(await p.w.__yeghadamPeerQuote(points)), { status: 'none' });
  }
  assert.equal(p.requests.length, 0);
});

test('stopping a search aborts the price request it is waiting on', { timeout: 10000 }, async () => {
  const p = page((url, init) => (url.includes('/api/v3/price') ? stall(url, init) : Promise.reject(new Error('no tiles'))));
  p.w.sessionStorage.setItem('yeghadam:route', JSON.stringify({ points: ROUTE, category: 1, t: 0 }));
  const dbg = p.w.__yeghadamDebug;
  dbg.state.route = { points: ROUTE, category: 1, t: 0 };
  const running = dbg.run();
  while (!dbg.state.abort) await new Promise((r) => setImmediate(r));
  dbg.state.cancel = true;
  dbg.state.abort.abort(); // what the stop button does
  await running;
  assert.equal(dbg.state.running, false);
  assert.equal(dbg.state.error, null, 'a stopped search shows no error');
  assert.equal(p.requests.filter((r) => r.url.includes('/api/v3/price')).length, 1, 'no retry after the stop');
});

test('without AbortController (old WebViews) a request with no answer still times out', { timeout: 10000 }, async () => {
  const p = page(stall, true);
  assert.deepEqual(plain(await p.w.__yeghadamPeerQuote(ROUTE)), { status: 'none' });
  assert.equal(p.requests.length, 2);
});

test('settings with unknown values fall back to the defaults', () => {
  const s = page(() => answer(OK), false, { auto: 'yes', depth: 'huge' }).w.__yeghadamDebug.settings();
  assert.equal(s.auto, false);
  assert.equal(s.depth, 'full');
  const t = page(() => answer(OK), false, { auto: true, depth: 'quick' }).w.__yeghadamDebug.settings();
  assert.equal(t.auto, true);
  assert.equal(t.depth, 'quick');
});

test('the search depth setting caps the quotes one search spends', { timeout: 20000 }, async () => {
  const spent = async (depth) => {
    const p = page((url) => (url.includes('/api/v3/price') ? answer(OK) : Promise.reject(new Error('no tiles'))), false, { depth });
    const dbg = p.w.__yeghadamDebug;
    dbg.state.route = { points: ROUTE, category: 1, t: 0 };
    await dbg.run();
    assert.equal(dbg.state.result.planned, depth === 'quick' ? 15 : 25);
    return p.requests.filter((r) => r.url.includes('/api/v3/price')).length;
  };
  const quick = await spent('quick'), full = await spent('full');
  assert.ok(quick <= 15, `quick spent ${quick}`);
  assert.ok(full > quick && full <= 25, `full spent ${full}, quick ${quick}`);
});

// The page's own price request for a route, as Snapp's web app sends it; the script tracks the route from it.
const sitePriceRequest = (w, points) => w.fetch('/api/v3/price', { method: 'POST', body: JSON.stringify({ points: points.map((p) => ({ lat: String(p.lat), lng: String(p.lng) })), categories: [1] }) });
const settle = () => new Promise((r) => setTimeout(r, 60));

test('automatic search runs once for a newly confirmed route, only when turned on', { timeout: 20000 }, async () => {
  const net = (url) => (url.includes('/api/v3/price') ? answer(OK) : Promise.reject(new Error('no tiles')));
  const off = page(net, false, { seenGuide: true });
  await sitePriceRequest(off.w, ROUTE); await settle();
  assert.equal(off.w.__yeghadamDebug.state.result, null, 'off by default');

  const on = page(net, false, { seenGuide: true, auto: true, depth: 'quick' });
  await sitePriceRequest(on.w, ROUTE); await settle();
  const st = on.w.__yeghadamDebug.state;
  while (st.running) await settle();
  assert.ok(st.result && st.result.base, 'searched on its own');
  assert.equal(on.usage().search.length, 1);
  await sitePriceRequest(on.w, ROUTE); await settle();
  assert.equal(on.usage().search.length, 1, 'the same route is not searched again');
});

test('automatic search leaves two searches for the rider under the 10-minute limit', { timeout: 20000 }, async () => {
  const p = page((url) => (url.includes('/api/v3/price') ? answer(OK) : Promise.reject(new Error('no tiles'))), false, { seenGuide: true, auto: true });
  const now = Date.now();
  p.w.localStorage.setItem('yeghadam:usage', JSON.stringify({ search: [now - 60e3, now - 120e3, now - 180e3] }));
  await sitePriceRequest(p.w, ROUTE); await settle();
  assert.equal(p.w.__yeghadamDebug.state.running, false);
  assert.equal(p.w.__yeghadamDebug.state.result, null);
  assert.equal(p.usage().search.length, 3, 'no automatic search after three in ten minutes');
});

// The app's side of the shared flags: one store for both services, with the same checks as MainActivity.setFlag.
function appFlags(initial) {
  const flags = new Map(Object.entries(initial || {}));
  const ok = { peer: /^(on|off)?$/, depth: /^(quick|full)?$/, budgets: /^((0|100|200|300):(0|100|200|300))?$/ };
  return {
    flags,
    getFlag: (k) => flags.get(k) || '',
    setFlag: (k, v) => { if ((ok[k] || /^1?$/).test(v)) flags.set(k, v); },
    consentVersion: () => 1,
  };
}

test('Android: a page takes the settings the app keeps for both services over its own', () => {
  const app = appFlags({ depth: 'quick', auto: '1', budgets: '100:300' }); // saved from the other service's tab
  const tapsi = page(() => answer(OK), false, { depth: 'full', budgets: { origin: 200, dest: 200 } }, app).w.__yeghadamDebug.settings();
  assert.equal(tapsi.depth, 'quick');
  assert.equal(tapsi.auto, true);
  assert.deepEqual(plain(tapsi.budgets), { origin: 100, dest: 300 });
});

test('Android: a page hands its own settings to the app, and re-reads them when its tab comes forward', () => {
  const app = appFlags();
  page(() => answer(OK), false, { depth: 'quick', budgets: { origin: 0, dest: 200 } }, app);
  assert.equal(app.flags.get('depth'), 'quick');
  assert.equal(app.flags.get('budgets'), '0:200');
  const other = page(() => answer(OK), false, null, app);
  app.setFlag('depth', 'full'); // changed in the other tab
  other.w.__yeghadamFocus();
  assert.equal(other.w.__yeghadamDebug.settings().depth, 'full');
});

test('Android: values the app does not know fall back to the defaults', () => {
  const app = appFlags();
  app.flags.set('depth', 'huge'); app.flags.set('budgets', '999:5');
  const s = page(() => answer(OK), false, null, app).w.__yeghadamDebug.settings();
  assert.equal(s.depth, 'full');
  assert.deepEqual(plain(s.budgets), { origin: 200, dest: 200 });
});

test('settings open without a route and close back to the map', () => {
  const p = page(() => answer(OK), false, { seenGuide: true });
  const st = p.w.__yeghadamDebug.state;
  assert.equal(st.route, null);
  p.w.__yeghadamPrefs();
  assert.equal(st.prefs, true);
  assert.equal(st.sheet, true);
  assert.equal(p.w.__yeghadamBack(), true, 'back closes the settings');
  assert.equal(st.prefs, false);
  assert.equal(st.sheet, false, 'no route: the panel closes too');
});
