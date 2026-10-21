/*
 * Yeghadam page layer. Runs inside app.snapp.taxi: as the extension content script (page world) or inside the Android
 * WebView. Needs YeghadamCore (src/core.js) loaded first.
 * Network: POST /api/v3/price with the user's own token, and GET public map tiles from tile.snappmaps.ir.
 * It never requests a ride.
 */
(() => {
  'use strict';
  if (window.__YEGHADAM__ || location.hostname !== 'app.snapp.taxi') return;
  window.__YEGHADAM__ = true;

  const C = window.YeghadamCore;
  const NATIVE = window.YeghadamNative || null;
  const PRICE_PATH = '/api/v3/price';
  const TILE_URL = 'https://tile.snappmaps.ir/data/v4/';
  const SETTINGS_KEY = 'yeghadam:settings';
  const ROUTE_KEY = 'yeghadam:route';
  const BUDGETS = [100, 200, 300];
  // The price page also prefetches the delivery tab (category 3). The car route is tracked, and the user picks
  // user pick what to price on it: car (1) or motorbike (2). Never box.
  const CAR = 1, BIKE = 2;
  // Motorbikes are not offered in every city: offer the switch only when the quote for
  // this route lists category 2, and fall back to car otherwise.
  const bikeOffered = () => !!(state.snapp && (state.snapp.categories || []).some((c) => c.id === BIKE));
  const cat = () => (settings.category === BIKE && bikeOffered() ? BIKE : CAR);

  const nativeFetch = window.fetch.bind(window);
  const defaults = { budget: 200, category: CAR, services: {}, seenGuide: false };
  let settings = Object.assign({}, defaults, safeJSON(lsGet(SETTINGS_KEY)) || {});
  if (settings.category !== CAR && settings.category !== BIKE) settings.category = CAR;
  if (!settings.services || typeof settings.services !== 'object') settings.services = {};

  const state = {
    route: carRoute(safeJSON(ssGet(ROUTE_KEY))), // { points, category, t }
    snapp: null,        // Snapp's own latest quote for state.route: { prices, names }
    map: null,
    running: false,
    cancel: false,
    result: null,       // YeghadamCore.search result
    resultKey: '',      // route the result belongs to
    selected: null,     // candidate highlighted on the map
    error: null,
    sheet: false,
    setup: true,        // show budget chips / cap in the sheet
    capText: '',
    probe: null,        // long-press quote: { kind, lat, lng, walk, dir, prices, base, approx }
    apply: null,        // { steps: [{ kind, c }], i, phase: 'fly'|'confirm'|'manual' }
    applied: null,
    toast: null,
  };

  // First run: what the app does, then the notice that it is unofficial, accepted before anything else runs.
  // NOTICE_V goes up only when the notice says something new (risk, data, what the app does). On Android the
  // acceptance is also kept by the app, so it survives Snapp clearing the page's storage at logout.
  const NOTICE_V = 1, CONSENT_KEY = 'yeghadam:consent';
  function consentVersion() {
    let v = 0;
    try { if (NATIVE && NATIVE.consentVersion) v = +NATIVE.consentVersion() || 0; } catch (e) {}
    const local = safeJSON(lsGet(CONSENT_KEY));
    return Math.max(v, (local && +local.v) || 0);
  }
  // 0: intro, 1: notice, null: done. Riders who used an earlier version only see the notice.
  state.intro = consentVersion() >= NOTICE_V ? null : settings.seenIntro || settings.seenGuide ? 1 : 0;
  state.fromIntro = state.intro === 0;
  const introOpen = (open) => { try { if (NATIVE && NATIVE.introOpen) NATIVE.introOpen(open); } catch (e) {} };

  function carRoute(r) { return r && Array.isArray(r.points) && r.category === CAR ? r : null; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function safeJSON(s) { try { return JSON.parse(s); } catch (e) { return null; } }
  function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const routeKey = (r) => (r ? r.points.map((p) => (+p.lat).toFixed(5) + ',' + (+p.lng).toFixed(5)).join(';') + '|' + r.category : '');

  /* ---------------- watch Snapp's own price requests ---------------- */
  function onSnappRequest(bodyText) {
    try {
      const b = JSON.parse(bodyText);
      if (!Array.isArray(b.points) || b.points.length < 2) return null;
      const cats = Array.isArray(b.categories) ? b.categories.map(Number) : [CAR];
      if (!cats.includes(CAR)) return null; // delivery and motorbike quotes do not change the car route
      return { points: b.points.map((p) => ({ lat: +p.lat, lng: +p.lng })), category: CAR, t: Date.now() };
    } catch (e) { return null; }
  }
  function onSnappResponse(route, json) {
    if (!route) return;
    const services = json && json.data && json.data.services;
    if (Array.isArray(services)) json.data.services = services.filter((s) => s.category_id == null || s.category_id === CAR);
    setTimeout(() => onRoute(route, json ? C.parsePrices(json) : null), 0);
  }
  window.fetch = function (input, init) {
    let route = null;
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes(PRICE_PATH) && init && typeof init.body === 'string') route = onSnappRequest(init.body);
    } catch (e) {}
    const p = nativeFetch(input, init);
    if (route) p.then((r) => r.clone().json()).then((j) => onSnappResponse(route, j), () => onSnappResponse(route, null));
    return p;
  };
  const xOpen = XMLHttpRequest.prototype.open, xSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__yeghadamUrl = String(u || ''); return xOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this.__yeghadamUrl && this.__yeghadamUrl.includes(PRICE_PATH) && typeof body === 'string') {
        const route = onSnappRequest(body);
        if (route) this.addEventListener('loadend', () => onSnappResponse(route, safeJSON(this.responseText)));
      }
    } catch (e) {}
    return xSend.apply(this, arguments);
  };

  // Snapp also prices previews while a pin is dragged in edit mode, and the edit may be abandoned. The confirmed route
  // is the latest request whose first and last points sit on the origin and destination markers on the map.
  const recent = [];
  function onRoute(route, quote) {
    if (quote && Object.keys(quote.prices).length) route.quote = Object.assign(quote, { at: Date.now() });
    recent.push(route);
    if (recent.length > 40) recent.shift();
    syncRoute();
  }
  // Screen positions of Snapp's labelled markers of one kind (a route with a stop has two destination markers).
  function markerPx(kind) {
    const out = [];
    for (const m of document.querySelectorAll('.mapboxgl-marker')) {
      if (!C.normalizeFa(m.textContent).includes(LABEL[kind])) continue;
      const t = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(m.style.transform || '');
      if (t) out.push([+t[1], +t[2]]);
    }
    return out;
  }
  function confirmedRoute() {
    const map = state.map;
    if (!map) return recent[recent.length - 1] || null; // no map yet: best guess
    const o = markerPx('origin'), d = markerPx('dest');
    if (!o.length || !d.length) return null; // markers hidden (edit mode): nothing is confirmed right now
    // marker positions are whole pixels: 2 px allows rounding, yet rejects a preview 15 m away at zoom 13
    const on = (p, list) => { const q = map.project([p.lng, p.lat]); return list.some((px) => Math.hypot(q.x - px[0], q.y - px[1]) < 2); };
    for (let i = recent.length - 1; i >= 0; i--) {
      const r = recent[i];
      if (on(r.points[0], o) && on(r.points[r.points.length - 1], d)) return r;
    }
    return null;
  }
  function syncRoute() {
    const route = confirmedRoute();
    if (!route) return;
    if (route.quote) state.snapp = Object.assign({}, route.quote, { key: routeKey(route) });
    if (route === state.route) return;
    state.route = route;
    try { sessionStorage.setItem(ROUTE_KEY, JSON.stringify({ points: route.points, category: route.category, t: route.t })); } catch (e) {}
    if (state.apply) { advanceApply(route); emit(); return; }
    const key = routeKey(route);
    if (state.resultKey && key !== state.resultKey) {
      if (state.running) state.cancel = true;
      state.result = null; state.resultKey = ''; state.selected = null; state.error = null;
      state.probe = null; state.applied = null; state.setup = true; state.capText = '';
      drawMap();
    }
    emit();
  }

  /* ---------------- Snapp's map (mapbox-gl v1) ---------------- */
  function patchMapbox(mb) {
    if (!mb || !mb.Map || mb.Map.prototype.__yeghadam) return;
    const P = mb.Map.prototype;
    P.__yeghadam = true;
    for (const k of ['_render', 'triggerRepaint', 'fire', 'getCenter']) {
      const orig = P[k];
      if (typeof orig !== 'function') continue;
      P[k] = function () {
        if (state.map !== this) {
          try { if (this.getContainer && document.contains(this.getContainer())) { state.map = this; onMapFound(this); } } catch (e) {}
        }
        return orig.apply(this, arguments);
      };
    }
  }
  if (window.mapboxgl) patchMapbox(window.mapboxgl);
  else {
    try {
      let mb;
      Object.defineProperty(window, 'mapboxgl', { configurable: true, enumerable: true, get() { return mb; }, set(v) { mb = v; try { patchMapbox(v); } catch (e) {} } });
    } catch (e) {}
  }
  let pollN = 0;
  const poll = setInterval(() => { if (window.mapboxgl) patchMapbox(window.mapboxgl); if (state.map || ++pollN > 240) clearInterval(poll); }, 500);

  let needsDraw = false;
  function onMapFound(map) {
    if (!map.__yeghadamBound) {
      map.__yeghadamBound = true;
      map.on('style.load', () => { needsDraw = true; drawMap(); });
      map.on('idle', () => { if (needsDraw) drawMap(); });
      map.on('move', positionTapHint);
      map.on('contextmenu', (e) => probeAt(e.lngLat));
      bindLongPress(map);
    }
    drawMap();
    emit();
  }

  // Long press on the map (touch): quote that single point.
  function bindLongPress(map) {
    const el = map.getCanvasContainer();
    let timer = 0, x0 = 0, y0 = 0;
    const clear = () => { clearTimeout(timer); timer = 0; };
    el.addEventListener('touchstart', (e) => {
      clear();
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      x0 = t.clientX; y0 = t.clientY;
      timer = setTimeout(() => {
        timer = 0;
        const r = el.getBoundingClientRect();
        probeAt(map.unproject([x0 - r.left, y0 - r.top]));
      }, 650);
    }, { passive: true });
    el.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (t && Math.hypot(t.clientX - x0, t.clientY - y0) > 10) clear(); }, { passive: true });
    el.addEventListener('touchend', clear, { passive: true });
    el.addEventListener('touchcancel', clear, { passive: true });
  }

  /* ---------------- data sources ---------------- */
  function authHeader() {
    let t = lsGet('accessToken');
    if (!t) return null;
    const j = safeJSON(t);
    if (typeof j === 'string') t = j;
    return /^bearer /i.test(t) ? t : 'Bearer ' + t;
  }
  async function quote(points) {
    const body = JSON.stringify(C.priceBody(points, cat()));
    for (let attempt = 0; attempt < 4; attempt++) {
      if (state.cancel) throw new C.SearchError('cancel');
      const auth = authHeader();
      if (!auth) throw new C.SearchError('auth');
      let r;
      try {
        r = await nativeFetch(PRICE_PATH, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', authorization: auth }, body });
      } catch (e) { await sleep(1500 * (attempt + 1)); continue; }
      if (r.status === 401 || r.status === 403) throw new C.SearchError('auth');
      if (r.status === 400) throw new C.SearchError('unavailable'); // e.g. no motorbikes on this route
      if (r.status === 429) { await sleep(3000 * (attempt + 1)); continue; }
      if (!r.ok) { await sleep(1000 * (attempt + 1)); continue; }
      const json = await r.json().catch(() => null);
      if (!json || !json.data || !Array.isArray(json.data.services)) throw new C.SearchError('changed');
      return C.parsePrices(json);
    }
    noteUsage('cool');
    throw new C.SearchError('rate');
  }

  const tiles = new Map();
  function loadTile(t) {
    const k = t.z + '/' + t.x + '/' + t.y;
    if (!tiles.has(k)) {
      if (tiles.size > 24) tiles.delete(tiles.keys().next().value);
      const p = nativeFetch(TILE_URL + k + '.pbf')
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('tile ' + r.status))))
        .then((b) => C.decodeTile(new Uint8Array(b), t));
      p.catch(() => tiles.delete(k));
      tiles.set(k, p);
    }
    return tiles.get(k);
  }
  async function getFeatures(center, R) {
    try {
      const parts = await Promise.all(C.tilesAround(center, R).map(loadTile));
      return [].concat(...parts);
    } catch (e) {
      // fall back to whatever the map has loaded
      const map = state.map;
      if (!map) return [];
      try {
        return map.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation' }).map((f) => ({
          props: f.properties,
          lines: f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [],
        }));
      } catch (e2) { return []; }
    }
  }

  /* ---------------- account safety ---------------- */
  // Every search sends up to 25 quotes from the user's own account. Keep the pace well below anything that looks
  // automated: a few searches per 10 minutes, a cap per hour, single-point quotes counted separately, and a pause
  // after the server answers 429.
  const USAGE_KEY = 'yeghadam:usage';
  const LIMITS = { search: [[10 * 60e3, 5], [60 * 60e3, 15]], probe: [[10 * 60e3, 20]], cool: [[5 * 60e3, 1]] };
  function usage() {
    const u = safeJSON(lsGet(USAGE_KEY)) || {};
    const now = Date.now();
    for (const k of Object.keys(LIMITS)) u[k] = (Array.isArray(u[k]) ? u[k] : []).filter((t) => now - t < 60 * 60e3);
    return u;
  }
  function noteUsage(kind) {
    const u = usage();
    u[kind].push(Date.now());
    try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)); } catch (e) {}
  }
  // minutes to wait before another `kind` action, 0 when allowed
  function waitFor(kind) {
    const u = usage(), now = Date.now();
    let wait = 0;
    const check = (k) => {
      for (const [span, max] of LIMITS[k]) {
        const recent = u[k].filter((t) => now - t < span).sort((a, b) => a - b);
        if (recent.length >= max) wait = Math.max(wait, recent[recent.length - max] + span - now);
      }
    };
    check('cool');
    check(kind);
    return Math.ceil(wait / 60e3);
  }

  /* ---------------- search ---------------- */
  async function run() {
    syncRoute();
    if (state.running || !state.route || state.intro != null || state.off) return;
    const wait = waitFor('search');
    if (wait) { state.error = 'slow'; state.waitMin = wait; state.setup = true; emit(); return; }
    noteUsage('search');
    state.running = true; state.cancel = false; state.error = null; state.selected = null;
    state.probe = null; state.applied = null; state.setup = false;
    state.resultKey = routeKey(state.route);
    state.result = null;
    emit(); drawMap();
    const res = await C.search({
      route: { points: state.route.points, category: cat() },
      budget: settings.budget,
      serviceId: settings.services[cat()] || undefined,
      quote, getFeatures,
      isCancelled: () => state.cancel,
      onProgress: (r) => { if (state.resultKey === keyOf(r)) { ensureIds(r); state.result = r; scheduleDraw(); emit(); } },
    });
    state.running = false;
    state.cancel = false;
    if (keyOf(res) !== state.resultKey) { emit(); return; } // route changed meanwhile
    ensureIds(res);
    state.result = res;
    if (res.error && res.error !== 'cancel') state.error = res.error;
    const top = currentCards()[0];
    state.selected = top ? top.c : null;
    emit(); drawMap();
  }
  const keyOf = (r) => routeKey({ points: r.routePoints, category: CAR }); // result category is cleared on switch
  // stable ids, so the sheet and the map can refer to candidates
  function ensureIds(r) {
    r.origins.forEach((c, i) => { if (!c.id) c.id = 'o' + i; });
    r.dests.forEach((c, i) => { if (!c.id) c.id = 'd' + i; });
    if (r.combo && !r.combo.id) r.combo.id = 'b';
  }
  // service to compare: the user's pick for this category, else the first one Snapp lists (its default)
  const sid = () => {
    const want = settings.services[cat()], r = state.result;
    if (r && r.base) return r.base.prices[want] ? want : r.sid;
    const p = cat() === CAR && state.snapp ? state.snapp.prices : null;
    if (p) return p[want] ? want : +Object.keys(p)[0];
    return want;
  };
  const currentCards = () => (state.result && state.result.base ? C.cards(state.result, sid()) : []);
  const allQuoted = () => {
    const r = state.result;
    const list = r ? r.origins.concat(r.dests) : [];
    if (state.probe) list.push(state.probe);
    return list;
  };

  // Long press / right click: quote one point as the origin or the destination, whichever is nearer.
  async function probeAt(ll) {
    if (!ll || !state.route || state.running || state.apply || state.intro != null || state.off) return;
    const pts = state.route.points, O = pts[0], D = pts[pts.length - 1];
    const p = { lat: ll.lat, lng: ll.lng };
    const dO = C.distance(p, O), dD = C.distance(p, D);
    if (Math.min(dO, dD) > 600) { notify('نزدیک مبدا یا مقصد نگه دار.'); return; }
    const wait = waitFor('probe');
    if (wait) { notify(`برای امنیت حسابت، ${fa(wait)} دقیقهٔ دیگه دوباره امتحان کن.`); return; }
    noteUsage('probe');
    const kind = dO <= dD ? 'origin' : 'dest', from = kind === 'origin' ? O : D;
    const pr = C.projector(from), [x, y] = pr.xy(p.lng, p.lat);
    const probe = { id: 'p' + Date.now(), kind, lat: p.lat, lng: p.lng, walk: Math.round(Math.hypot(x, y)), dir: C.direction(x, y), approx: true, probe: true, loading: true };
    state.probe = probe; state.sheet = false; emit(); drawMap();
    try {
      const np = pts.slice();
      np[kind === 'origin' ? 0 : np.length - 1] = p;
      const q = await quote(np);
      probe.prices = q.prices;
      probe.names = q.names;
      // compare with the newest price for the current route: what Snapp shows now, or the last search if newer
      const key = routeKey(state.route), r = state.result;
      const ours = r && r.base && key === state.resultKey ? { prices: r.base.prices, at: r.at } : null;
      const snapp = cat() === CAR && state.snapp && state.snapp.key === key ? state.snapp : null;
      const base = ours && (!snapp || ours.at >= snapp.at) ? ours : snapp;
      probe.base = base ? base.prices : null;
    } catch (e) { probe.error = e.code || 'unknown'; }
    probe.loading = false;
    if (state.probe === probe) { emit(); drawMap(); }
  }

  /* ---------------- drawing on Snapp's map ---------------- */
  let drawTimer = 0;
  function scheduleDraw() { if (!drawTimer) drawTimer = setTimeout(() => { drawTimer = 0; drawMap(); }, 120); }
  const lineOf = (path) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: path.map((p) => [p.lng, p.lat]) }, properties: {} });
  function drawMap() {
    const map = state.map;
    if (!map) return;
    try {
      if (!map.style || !map.style._loaded) { needsDraw = true; return; }
      needsDraw = false;
      const r = state.result, s = sid();
      const pts = { type: 'FeatureCollection', features: [] }, paths = { type: 'FeatureCollection', features: [] };
      const basePrice = r && r.base ? C.priceOf(r.base, s) : Infinity;
      for (const c of allQuoted()) {
        if (!c.prices && !c.loading) continue;
        const ref = c.probe && c.base ? c.base[s] || Infinity : basePrice;
        const delta = c.loading ? 0 : C.priceOf(c, s) - ref;
        pts.features.push({
          type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
          properties: { id: c.id || '', tone: c.loading ? 0 : delta <= -C.MIN_SAVING ? 1 : delta >= C.MIN_SAVING ? 3 : 2, sel: c === state.selected || c === state.probe ? 1 : 0 },
        });
      }
      const sel = state.selected;
      if (sel) {
        if (sel.kind === 'both') { paths.features.push(lineOf(sel.origin.path), lineOf(sel.dest.path)); }
        else if (sel.path && sel.path.length > 1) paths.features.push(lineOf(sel.path));
      }
      drawBadges();
      const src = map.getSource('yeghadam-pts');
      if (src) { src.setData(pts); map.getSource('yeghadam-path').setData(paths); return; }
      if (!pts.features.length) return;
      map.addSource('yeghadam-pts', { type: 'geojson', data: pts });
      map.addSource('yeghadam-path', { type: 'geojson', data: paths });
      map.addLayer({ id: 'yeghadam-path', type: 'line', source: 'yeghadam-path', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#15192e', 'line-width': 4, 'line-dasharray': [0.6, 1.6], 'line-opacity': 0.9 } });
      map.addLayer({
        id: 'yeghadam-pts', type: 'circle', source: 'yeghadam-pts',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'sel'], 1], 10, 6],
          'circle-color': ['match', ['get', 'tone'], 1, '#65a30d', 3, '#dc2626', 0, '#15192e', '#94a3b8'],
          'circle-stroke-color': ['case', ['==', ['get', 'sel'], 1], '#0f172a', '#ffffff'],
          'circle-stroke-width': ['case', ['==', ['get', 'sel'], 1], 3, 1.5],
          'circle-opacity': 0.95,
        },
      });
      if (map.__yeghadamClick) return;
      map.__yeghadamClick = true;
      map.on('click', 'yeghadam-pts', (e) => {
        const f = e.features && e.features[0];
        const c = f && allQuoted().find((x) => x.id && x.id === f.properties.id);
        if (c && !state.apply) { state.selected = c; state.sheet = true; state.setup = false; drawMap(); emit(); if (phone()) moveMapTo(c, null, true); }
      });
    } catch (e) { needsDraw = true; console.warn('[yeghadam] draw', e); }
  }
  // Numbered badges on the map, matching the result cards (1, 2, 3).
  let badges = [], badgeSig = '';
  function drawBadges() {
    const map = state.map, mb = window.mapboxgl;
    const want = state.result && state.result.base && !state.running && !state.apply ? currentCards().map((k, i) => ({ card: k.c, at: k.c.kind === 'both' ? k.c.dest : k.c, n: i + 1 })) : [];
    const sig = want.map((w) => w.card.id + (w.card === state.selected ? '*' : '')).join(',');
    if (sig === badgeSig) return;
    badgeSig = sig;
    badges.forEach((m) => m.remove());
    badges = [];
    if (!map || !mb || !mb.Marker) return;
    for (const w of want) {
      const on = w.card === state.selected, el = document.createElement('div');
      el.textContent = fa(w.n);
      el.style.cssText = `width:${on ? 32 : 28}px;height:${on ? 32 : 28}px;border-radius:50%;box-sizing:border-box;border:2.5px solid #15192e;background:${on ? '#c5f04a' : '#fff'};color:#15192e;font:800 ${on ? 15 : 13.5}px/1 ${FONT};display:grid;place-items:center;box-shadow:0 6px 14px -4px rgba(15,18,40,.5);cursor:pointer`;
      el.addEventListener('click', (e) => { e.stopPropagation(); state.selected = w.card; state.sheet = true; state.setup = false; drawMap(); emit(); if (phone()) moveMapTo(w.at, null, true); });
      badges.push(new mb.Marker({ element: el, anchor: 'bottom', offset: [0, -8] }).setLngLat([w.at.lng, w.at.lat]).addTo(map));
    }
  }
  // lift: centre the point in the part of the map left visible above the phone's bottom sheet. The guided apply
  // never lifts: Snapp's pin must land exactly on the point.
  function moveMapTo(c, ms, lift) {
    if (!state.map || !c) return false;
    const opt = { center: [c.lng, c.lat], zoom: Math.max(state.map.getZoom(), 16.5), duration: ms == null ? 700 : ms };
    const dy = lift ? liftOffset() : 0;
    if (dy) opt.offset = [0, dy];
    state.map.easeTo(opt);
    return true;
  }
  function liftOffset() {
    const map = state.map, pn = root && root.querySelector('.pn');
    if (!map || !pn || !phone()) return 0;
    try {
      const box = map.getContainer().getBoundingClientRect(), c = map.project(map.getCenter());
      const top = box.top + 56, bottom = pn.getBoundingClientRect().top; // 56: Snapp's own buttons at the top
      if (bottom - top < 80) return 0;
      return Math.round((top + bottom) / 2 - (box.top + c.y));
    } catch (e) { return 0; }
  }

  /* ---------------- guided apply ---------------- */
  const LABEL = { origin: 'مبدا', dest: 'مقصد' };
  function findSnappLabel(kind) {
    const txt = LABEL[kind];
    const has = (el) => C.normalizeFa(el.textContent).includes(txt);
    for (const m of document.querySelectorAll('.mapboxgl-marker')) {
      if (!has(m)) continue;
      let el = m, found = true; // deepest element that still contains the label text
      while (found) {
        found = false;
        for (const ch of el.children) if (has(ch)) { el = ch; found = true; break; }
      }
      return el;
    }
    return null;
  }
  function tap(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1, pointerType: 'touch', isPrimary: true };
    try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mousedown', o));
    try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }
  function stepsFor(c) { return c.kind === 'both' ? [{ kind: 'origin', c: c.origin }, { kind: 'dest', c: c.dest }] : [{ kind: c.kind, c }]; }
  function startApply(c) {
    state.apply = { steps: stepsFor(c), i: 0, phase: 'fly', target: c };
    state.sheet = false; state.probe = c.probe ? c : null;
    emit();
    doApplyStep();
  }
  function doApplyStep() {
    const a = state.apply;
    if (!a) return;
    const s = a.steps[a.i];
    const label = findSnappLabel(s.kind);
    if (!label) { a.phase = 'manual'; emit(); return; }
    tap(label);
    a.phase = 'fly';
    emit();
    setTimeout(() => {
      if (state.apply !== a) return;
      moveMapTo(s.c, 650);
      setTimeout(() => { if (state.apply === a) { a.phase = 'confirm'; emit(); positionTapHint(); } }, 750);
    }, 650);
  }
  function continueManual() {
    const a = state.apply;
    if (!a) return;
    moveMapTo(a.steps[a.i].c, 650);
    setTimeout(() => { if (state.apply === a) { a.phase = 'confirm'; emit(); positionTapHint(); } }, 750);
  }
  function advanceApply(route) {
    const a = state.apply, s = a.steps[a.i];
    const p = s.kind === 'origin' ? route.points[0] : route.points[route.points.length - 1];
    if (C.distance(p, s.c) > 12) return;
    a.i++;
    if (a.i < a.steps.length) {
      a.phase = 'fly';
      setTimeout(() => { if (state.apply === a) doApplyStep(); }, 1100);
      return;
    }
    state.apply = null;
    state.applied = a.target;
    state.resultKey = routeKey(route); // the result now describes the applied route; keep showing it
    notify('اعمال شد. حالا برو سر نقطهٔ جدید؛ قیمت تازه توی اسنپه.');
  }
  function cancelApply() { state.apply = null; emit(); }

  /* ---------------- UI ---------------- */
  const fa = (n) => Number(n).toLocaleString('fa-IR');
  const toman = (rial) => (isFinite(rial) ? fa(Math.round(rial / 10)) + ' تومان' : '—');
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  function parseToman(s) {
    const d = String(s || '').replace(/[۰-۹]/g, (c) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c)).replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace(/\D/g, '');
    const n = +d;
    if (!n) return 0;
    return n < 1000 ? n * 1000 : n; // "160" means 160,000 toman
  }
  const ROAD = { primary: 'خیابان', secondary: 'خیابان', tertiary: 'خیابان', minor: 'کوچه', service: 'کوچه' };
  function placeText(c) {
    if (c.approx) return `${fa(c.walk)} متر ${c.dir} (خط هوایی)`;
    const street = c.street || ROAD[c.cls] || 'خیابان';
    return c.crossed ? `اون‌ور ${street}` : `${street}، ${c.dir}`;
  }
  const TAG = { nearest: 'نزدیک‌ترین', balanced: 'متعادل', cheapest: 'ارزون‌ترین', best: 'بهترین' };
  const ERR = {
    auth: 'وارد اکانت اسنپ نیستی یا نشستت تموم شده. یک بار خارج و دوباره وارد شو.',
    rate: 'اسنپ موقتاً استعلام‌ها رو محدود کرده. چند دقیقه بعد دوباره امتحان کن.',
    noprice: 'برای این مسیر قیمتی برنگشت.',
    budget: 'سقف تعداد استعلام پر شد.',
    unavailable: 'اسنپ این سرویس رو برای این مسیر نداره.',
    changed: 'اسنپ چیزی رو عوض کرده و این نسخه دیگه درست قیمت نمی‌گیره. نسخهٔ جدید رو نصب کن.',
    slow: 'برای امنیت حسابت، جستجوی بعدی رو کمی بعد انجام بده.',
    unknown: 'خطای غیرمنتظره. دوباره امتحان کن.',
  };
  const errText = (code) => (ERR[code] || ERR.unknown) + (code === 'slow' && state.waitMin ? ` (حدود ${fa(state.waitMin)} دقیقه)` : '');
  function notify(msg) {
    if (NATIVE && NATIVE.toast) { try { NATIVE.toast(msg); return; } catch (e) {} }
    state.toast = msg; emit();
    setTimeout(() => { if (state.toast === msg) { state.toast = null; emit(); } }, 2600);
  }

  // The page's own Persian face (document fonts also apply inside the shadow root), then safe fallbacks.
  const FONT = "IRANSansXFaNum, IRANSansX, Vazirmatn, Vazir, Tahoma, 'Segoe UI', sans-serif";
  // brand mark: a ring (you are here) and, one step over, a lime dot (cheaper). Same drawing as the app icon.
  const LOGO = `<svg class="lg" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="5.6" fill="#15192e"/><circle cx="7.9" cy="15.8" r="2.6" fill="none" stroke="#fff" stroke-width="1.3"/><circle cx="15.9" cy="8.7" r="4.6" fill="#c5f04a"/></svg>`;
  // Long press on a phone, right click with a mouse.
  // Phones get the panel as a bottom sheet over Snapp's ride sheet; wider screens keep it floating over the map.
  const phone = () => window.innerWidth < 640;
  const TOUCH = (() => { try { return matchMedia('(pointer:coarse)').matches; } catch (e) { return true; } })();

  // Line icons on a 24 grid, 2 px stroke.
  const svgIcon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    collapse: svgIcon('<path d="m18 15-6-6-6 6"/>'),
    down: svgIcon('<path d="m6 9 6 6 6-6"/>'),
    help: svgIcon('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
    close: svgIcon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    next: svgIcon('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>'),
    prev: svgIcon('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
    again: svgIcon('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'),
    shield: svgIcon('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>'),
    info: svgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
    alert: svgIcon('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
    check: svgIcon('<path d="M20 6 9 17l-5-5"/>'),
    clock: svgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
    lock: svgIcon('<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
    hand: svgIcon('<path d="M18 11V6a2 2 0 0 0-4 0"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'),
    walk: svgIcon('<path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/>'),
    pin: svgIcon('<path d="M20 10c0 5-5.54 10.19-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.19 4 15 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>'),
    origin: svgIcon('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2" fill="currentColor"/>'),
  };
  const KIND_ICON = { origin: ICON.origin, dest: ICON.pin, both: ICON.pin };
  const note = (kind, html, icon) => `<div class="note ${kind}">${icon || { ok: ICON.check, w: ICON.alert, e: ICON.alert, i: ICON.info }[kind]}<div>${html}</div></div>`;

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box;font-family:${FONT};-webkit-tap-highlight-color:transparent;margin:0;padding:0}
  .w{--ink:#15192e;--ink2:#3a4058;--mute:#636982;--line:#e7e9ef;--soft:#f2f3f7;--soft2:#e9ebf1;--lime:#c5f04a;--lime0:#f6fbe4;--leaf:#3f6212;
    --warn:#fff4e0;--warnI:#7a4606;--err:#fdeceb;--errI:#8f1f1f;--lift:0 18px 40px -14px rgba(15,18,40,.38),0 2px 6px rgba(15,18,40,.08);
    direction:rtl;color:var(--ink);font-size:14px;line-height:1.6;font-family:${FONT};font-variant-numeric:tabular-nums}
  button{font:inherit;color:inherit;cursor:pointer;border:0;background:none;text-align:inherit}
  button:focus-visible,input:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
  ::selection{background:var(--lime);color:var(--ink)}
  svg{display:block}
  .lg{width:24px;height:24px;flex:none}

  /* --sheet is the top edge of Snapp's bottom sheet (prices, ride button), measured at run time: stay above it */
  .pn{position:fixed;top:calc(env(safe-area-inset-top,0px) + 60px);left:10px;z-index:2147483000;width:min(380px,calc(100vw - 20px));
    background:#fff;border-radius:20px;box-shadow:var(--lift);overflow:hidden;display:flex;flex-direction:column;
    max-height:calc(var(--sheet,50vh) - 70px - env(safe-area-inset-top,0px));min-height:150px;transform-origin:50% 100%}
  .pn.in{animation:rise .32s cubic-bezier(.16,1,.3,1)}
  @keyframes rise{from{opacity:.3;transform:translateY(10px) scale(.97)}}
  .hd{display:flex;align-items:center;gap:8px;padding:8px 6px 6px 14px;padding-inline-start:14px;padding-inline-end:6px}
  .name{font-size:15px;font-weight:800;letter-spacing:-.01em}
  .unoff{font-size:10.5px;font-weight:700;color:var(--mute);border:1px solid var(--line);border-radius:999px;padding:0 7px;line-height:18px}
  .sp{flex:1}
  .ic{display:grid;place-items:center;width:36px;height:36px;border-radius:12px;color:var(--ink2);flex:none}
  .ic:hover{background:var(--soft)}
  .ic svg{width:20px;height:20px}
  .bar{height:3px;background:var(--soft);overflow:hidden;flex:none}
  .bar i{display:block;height:100%;width:100%;background:var(--ink);transform-origin:right;transition:transform .3s cubic-bezier(.16,1,.3,1)}
  .bd{flex:1;min-height:0;overflow:auto;padding:2px 14px 14px;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#d3d6df transparent}
  .dock{flex:none;padding:10px 14px 12px;border-top:1px solid var(--line);background:#fff}

  .lbl{display:flex;align-items:baseline;gap:6px;font-size:13px;font-weight:700;color:var(--ink2);margin:14px 0 7px}
  .lbl:first-child{margin-top:4px}
  .lbl small{font-size:12px;font-weight:500;color:var(--mute)}
  .seg{display:flex;gap:3px;padding:3px;background:var(--soft);border-radius:13px}
  .seg button{flex:1;min-width:0;min-height:38px;border-radius:10px;font-size:13.5px;font-weight:700;color:var(--ink2);text-align:center;transition:background .15s,color .15s}
  .seg button:hover{color:var(--ink)}
  .seg button.on{background:var(--ink);color:#fff;box-shadow:0 1px 2px rgba(15,18,40,.25)}
  .seg.sm button{min-height:32px;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 6px}
  .seg.sm button.on{background:#fff;color:var(--ink);box-shadow:0 1px 3px rgba(15,18,40,.16)}
  .seg.sm + .seg.sm{margin-top:6px}
  .fld{display:flex;align-items:center;gap:8px;min-height:42px;padding:0 12px;border:1.5px solid var(--line);border-radius:12px;background:#fff;transition:border-color .15s}
  .fld:focus-within{border-color:var(--ink)}
  .fld input{flex:1;min-width:0;border:0;outline:0;font:inherit;font-size:14px;color:var(--ink);background:none;direction:rtl;caret-color:var(--ink)}
  .fld input::placeholder{color:var(--mute);opacity:1}
  .fld .u{font-size:12.5px;color:var(--mute);white-space:nowrap}
  .btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:46px;border-radius:14px;font-size:15px;font-weight:800;
    background:var(--ink);color:#fff;text-align:center;transition:transform .12s,background .15s}
  .btn:active{transform:scale(.985)}
  .btn svg{width:18px;height:18px;color:var(--lime)}
  .btn:disabled{background:#c5c9d5;cursor:default}
  .btn:disabled svg{color:#fff}
  .btn.ghost{background:var(--soft);color:var(--ink);font-weight:700;min-height:42px}
  .btn.ghost svg{color:currentColor}
  .fine{display:flex;gap:6px;align-items:flex-start;font-size:12px;line-height:1.6;color:var(--mute);margin-top:10px}
  .fine svg{width:14px;height:14px;flex:none;margin-top:2px}

  .note{display:flex;gap:8px;align-items:flex-start;border-radius:12px;padding:9px 11px;font-size:13px;line-height:1.65;margin-top:8px;background:var(--lime0);color:#2b3a0c}
  .note svg{width:16px;height:16px;flex:none;margin-top:2px}
  .note.w{background:var(--warn);color:var(--warnI)}
  .note.e{background:var(--err);color:var(--errI)}
  .note.i{background:var(--soft);color:var(--ink2)}
  .lnk{display:inline;font-size:13px;font-weight:800;color:inherit;text-decoration:underline;text-decoration-thickness:1.5px;text-underline-offset:3px;padding:0 2px}

  .now{display:flex;align-items:center;gap:12px;margin:2px 0 4px}
  .now .seg{flex:1;min-width:0}
  .now .seg.sm + .seg.sm{margin:0}
  .base{flex:none;text-align:left;line-height:1.3}
  .now .base:only-child{flex:1;display:flex;justify-content:space-between;align-items:baseline;text-align:right}
  .base small{display:block;font-size:11.5px;color:var(--mute)}
  .now .base:only-child small{display:inline}
  .base b{font-size:15px;font-weight:800}
  .age{font-size:12px;color:var(--mute);margin:2px 0}

  .card{display:block;width:100%;margin-top:8px;padding:11px 12px 10px;border-radius:16px;background:var(--soft);border:1.5px solid transparent;cursor:pointer;transition:background .15s,border-color .15s,box-shadow .2s}
  .card:hover{background:var(--soft2)}
  .card.sel{background:#fff;border-color:var(--ink);box-shadow:0 8px 18px -10px rgba(15,18,40,.35)}
  .c1{display:flex;align-items:center;gap:10px}
  .n{width:26px;height:26px;flex:none;display:grid;place-items:center;border-radius:50%;border:2px solid var(--ink);background:#fff;font-size:13px;font-weight:800;line-height:1}
  .card.sel .n{background:var(--lime)}
  .sv{flex:1;min-width:0;font-size:16.5px;font-weight:800;color:var(--leaf);letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sv span{background:linear-gradient(transparent 56%,var(--lime) 56%,var(--lime) 90%,transparent 90%);padding:0 2px;-webkit-box-decoration-break:clone;box-decoration-break:clone}
  .wk{display:flex;align-items:center;gap:4px;flex:none;font-size:13px;font-weight:800;color:var(--ink)}
  .wk svg{width:15px;height:15px}
  .c2{display:flex;align-items:center;gap:6px;margin-top:5px;padding-inline-start:36px;font-size:13px;color:var(--ink2);min-width:0}
  .c2 svg{width:14px;height:14px;flex:none;color:var(--ink)}
  .c2 .pl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .c2 .pl b{font-weight:700;color:var(--ink)}
  .tag{flex:none;font-size:11px;font-weight:700;color:var(--mute)}
  .c3{display:flex;align-items:center;gap:6px;margin-top:9px;padding-top:9px;border-top:1px solid rgba(15,18,40,.07)}
  .meta{flex:1;min-width:0;font-size:12.5px;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .meta b{color:var(--ink);font-weight:700}
  .go{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:0 12px;border-radius:10px;font-size:13px;font-weight:800;background:var(--ink);color:#fff;flex:none;white-space:nowrap}
  .go svg{width:14px;height:14px;color:var(--lime)}
  .nb{min-height:34px;padding:0 10px;border-radius:10px;font-size:12.5px;font-weight:700;color:var(--mute);flex:none;white-space:nowrap}
  .nb:hover{background:rgba(15,18,40,.06);color:var(--ink)}
  .foot{display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid var(--line)}
  .tb{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:0 10px;margin-inline-start:-10px;border-radius:10px;font-size:13px;font-weight:800;color:var(--ink)}
  .tb:hover{background:var(--soft)}
  .tb svg{width:16px;height:16px}
  .foot .fine{margin:0;flex:1}
  .run{display:flex;align-items:center;gap:10px;padding:6px 0 2px}
  .run b{font-size:14px}
  .run small{display:block;font-size:12px;color:var(--mute)}

  .pill{position:fixed;top:calc(var(--sheet,50vh) - 58px);left:10px;z-index:2147483000;display:flex;align-items:center;gap:9px;max-width:calc(100vw - 20px);min-height:44px;
    padding-inline-start:6px;padding-inline-end:16px;border-radius:999px;background:var(--ink);color:#fff;font-size:14px;font-weight:800;white-space:nowrap;
    box-shadow:0 12px 26px -10px rgba(15,18,40,.6),0 2px 4px rgba(15,18,40,.16);transition:transform .12s}
  .pill:active{transform:scale(.97)}
  .pill .lg{width:32px;height:32px}
  .pill .lg rect{fill:#2a3050}
  .pill em{font-style:normal;color:var(--lime)}
  .pill.plain{background:#fff;color:var(--ink)}
  .pill.plain .lg rect{fill:var(--ink)}
  .pill.bad{background:#b42318}
  .pill.bad .lg rect{fill:#8f1c13}
  .pill .spin{margin:0 8px}

  .spin{width:16px;height:16px;flex:none;border-radius:50%;border:2px solid rgba(21,25,46,.16);border-top-color:var(--ink);animation:s .8s linear infinite}
  .pill .spin,.ab .spin{border-color:rgba(255,255,255,.25);border-top-color:var(--lime)}
  @keyframes s{to{transform:rotate(360deg)}}

  .ab{position:fixed;left:10px;top:calc(env(safe-area-inset-top,0px) + 60px);z-index:2147483003;width:min(380px,calc(100vw - 20px));background:var(--ink);color:#fff;
    border-radius:20px;padding:13px 16px 12px;box-shadow:0 18px 40px -12px rgba(15,18,40,.6);font-size:14px}
  .ab .top{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:700;color:var(--lime)}
  .ab .top svg{width:16px;height:16px;flex:none}
  .ab .top .sp{flex:1}
  .ab .top .t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .steps{display:flex;gap:4px}
  .steps i{width:6px;height:6px;border-radius:3px;background:rgba(255,255,255,.25)}
  .steps i.on{width:16px;background:var(--lime)}
  .ab .msg{display:flex;align-items:center;gap:10px;margin-top:7px;font-size:15px;font-weight:700;line-height:1.55}
  .ab .msg b{color:var(--lime)}
  .ab .sub{margin-top:3px;font-size:12.5px;color:#b8bdd0}
  .ab .big{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px;margin-top:6px}
  .ab .big b{font-size:21px;font-weight:800;letter-spacing:-.01em}
  .dl{font-size:12.5px;font-weight:800;border-radius:999px;padding:1px 9px}
  .dl.dn{background:var(--lime);color:var(--ink)}
  .dl.up{background:rgba(253,162,155,.16);color:#fdb4ad}
  .ab .acts{display:flex;gap:8px;margin-top:12px}
  .ab .go{flex:1;min-height:40px;background:var(--lime);color:var(--ink)}
  .ab .go svg{color:var(--ink)}
  .ab .nb{min-height:40px;padding:0 16px;background:rgba(255,255,255,.1);color:#fff}
  .ab .nb:hover{background:rgba(255,255,255,.16)}
  .ring{position:fixed;z-index:2147483000;width:72px;height:72px;margin:-36px 0 0 -36px;border-radius:50%;border:3px solid var(--lime);pointer-events:none;animation:p 1.3s cubic-bezier(.16,1,.3,1) infinite}
  @keyframes p{0%{transform:scale(.45);opacity:1}100%{transform:scale(1.35);opacity:0}}

  .toast{position:fixed;top:calc(env(safe-area-inset-top,0px) + 14px);left:50%;transform:translateX(-50%);z-index:2147483006;display:flex;align-items:center;gap:8px;
    background:var(--ink);color:#fff;border-radius:14px;padding:10px 14px;font-size:13.5px;font-weight:600;max-width:calc(100vw - 32px);width:max-content;box-shadow:var(--lift)}
  .toast svg{width:16px;height:16px;flex:none;color:var(--lime)}

  .gd{position:fixed;inset:0;z-index:2147483005;display:flex;align-items:flex-end;justify-content:center;background:rgba(12,14,30,.55);animation:dim .25s ease-out}
  @keyframes dim{from{background:rgba(12,14,30,0)}}
  .gs{width:100%;max-width:440px;max-height:calc(100% - 24px);overflow:auto;background:#fff;border-radius:24px 24px 0 0;padding:8px 20px calc(18px + env(safe-area-inset-bottom,0px));
    box-shadow:0 -12px 40px rgba(12,14,30,.25);animation:up .42s cubic-bezier(.16,1,.3,1)}
  @keyframes up{from{transform:translateY(40px)}}
  @media(min-width:640px){.gd{align-items:center}.gs{border-radius:24px;padding-bottom:18px}}
  .gtop{display:flex;align-items:center;gap:8px;height:44px}
  .gtop .name{font-size:14px}
  .gtop .ic{margin-inline-end:-8px}
  .art{height:170px;border-radius:18px;overflow:hidden;background:var(--soft)}
  .art svg{width:100%;height:100%;animation:swap .4s cubic-bezier(.16,1,.3,1)}
  @keyframes swap{from{opacity:.2;transform:translateX(-14px)}}
  .art .pulse{transform-box:fill-box;transform-origin:center;animation:p 1.6s cubic-bezier(.16,1,.3,1) infinite}
  .gtx{min-height:132px}
  .gs h2{font-size:19px;font-weight:800;letter-spacing:-.01em;line-height:1.45;margin-top:16px;text-wrap:balance}
  .gs p{font-size:14px;line-height:1.8;color:var(--ink2);margin-top:6px;max-width:60ch}
  .gl{list-style:none;margin-top:8px}
  .gl li{display:flex;gap:10px;align-items:flex-start;font-size:13.5px;line-height:1.7;color:var(--ink2);padding:6px 0}
  .gl li svg{width:18px;height:18px;flex:none;margin-top:3px;color:var(--ink)}
  .gl li + li{border-top:1px solid var(--line)}
  .gnav{display:flex;align-items:center;gap:8px;margin-top:16px}
  .dots{display:flex;gap:5px;flex:1}
  .dots i{width:7px;height:7px;border-radius:4px;background:var(--soft2);transition:background .3s}
  .dots i.on{width:20px;background:var(--ink)}
  .gnav .btn{width:auto;min-height:44px;padding:0 20px}
  .gnav .btn.ghost{padding:0 14px}
  .io{position:fixed;inset:0;z-index:2147483647;background:var(--ink);color:#fff;overflow:hidden;display:flex;justify-content:center}
  .io .glow{position:absolute;width:640px;height:640px;border-radius:50%;background:radial-gradient(circle,rgba(197,240,74,.15),rgba(197,240,74,0) 65%);left:-200px;bottom:-280px;pointer-events:none}
  .icol{position:relative;width:100%;max-width:460px;height:100%;display:flex;flex-direction:column;padding:calc(env(safe-area-inset-top,0px) + 18px) 24px calc(env(safe-area-inset-bottom,0px) + 18px)}
  .ib{display:flex;align-items:center;gap:10px;flex:none}
  .ib .lg{width:34px;height:34px}
  .ib .lg rect{fill:#262b47}
  .ib b{font-size:18px;font-weight:900}
  .ichip{font-size:12px;font-weight:700;color:var(--lime);border:1px solid rgba(197,240,74,.45);border-radius:999px;padding:1px 10px}
  .imain{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding-top:min(9vh,64px);scrollbar-width:none}
  .imain.note-page{padding-top:min(6vh,40px)}
  .io h1{font-size:clamp(30px,8.8vw,40px);font-weight:900;line-height:1.32;letter-spacing:-.02em;text-wrap:balance;animation:ri .6s cubic-bezier(.16,1,.3,1)}
  .io h1 em{font-style:normal;color:var(--lime)}
  .io p{margin-top:14px;font-size:16px;line-height:1.85;color:#b8bdd0;max-width:36ch}
  .iart{margin-top:28px;border-radius:22px;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);animation:ri .7s .06s cubic-bezier(.16,1,.3,1) backwards}
  .iart svg{width:100%;height:auto}
  .il{list-style:none;margin-top:18px}
  .il li{display:flex;gap:14px;align-items:flex-start;padding:13px 0;font-size:15px;line-height:1.75;color:#e4e7f1}
  .il li + li{border-top:1px solid rgba(255,255,255,.08)}
  .il i{width:32px;height:32px;flex:none;display:grid;place-items:center;border-radius:50%;border:1.5px solid rgba(197,240,74,.55);color:var(--lime)}
  .il i svg{width:16px;height:16px}
  .iact{flex:none;display:flex;flex-direction:column;gap:6px;padding-top:16px}
  .iact .dots{flex:none;justify-content:center;margin-bottom:10px}
  .io .dots i{background:rgba(255,255,255,.2)}
  .io .dots i.on{background:var(--lime)}
  .btn.lime{background:var(--lime);color:var(--ink);min-height:52px;font-size:16px}
  .btn.lime svg{color:var(--ink)}
  .io button:focus-visible{outline-color:var(--lime)}
  .itx{min-height:44px;text-align:center;font-size:14px;font-weight:700;color:#b8bdd0;border-radius:12px}
  .itx:hover{color:#fff}
  @media(max-height:720px){.io h1{font-size:28px}.imain.note-page{padding-top:16px}.il{margin-top:10px}.il li{padding:8px 0;font-size:14px;line-height:1.65}.io p{font-size:15px;margin-top:10px}.iart{margin-top:18px}.btn.lime{min-height:48px}}
  @keyframes ri{from{opacity:.2;transform:translateY(14px)}}
  .grab{display:none}
  @media(max-width:639px){
    .pn{top:auto;bottom:0;left:0;width:100%;min-height:0;max-height:min(64vh,calc(100vh - 150px));border-radius:22px 22px 0 0;
      padding-bottom:env(safe-area-inset-bottom,0px);box-shadow:0 -14px 36px -14px rgba(15,18,40,.4),0 -1px 0 rgba(15,18,40,.06)}
    .pn.in{animation:sheet .4s cubic-bezier(.16,1,.3,1)}
    .grab{display:grid;place-items:center;width:100%;height:16px;flex:none;cursor:grab}
    .grab i{width:40px;height:4px;border-radius:2px;background:#d3d6df}
    .hd{padding-top:0}
    .bd{padding-bottom:16px}
    .card{padding:12px 13px 11px}
    .sv{font-size:17px}
  }
  @keyframes sheet{from{transform:translateY(48px)}}
  @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
  `;

  let host, root, lastHTML = '';
  function mount() {
    if (host || !document.body) return;
    host = document.createElement('div');
    host.id = 'yeghadam-host';
    root = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
    root.addEventListener('click', onClick);
    layout();
    root.addEventListener('input', onInput);
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'cap') { e.preventDefault(); startRun(); }
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('card')) { e.preventDefault(); e.target.click(); }
      if (state.guide == null) return;
      if (e.key === 'Escape') closeGuide();
      else if (e.key === 'ArrowLeft') guideGo(1); // right to left: forward is to the left
      else if (e.key === 'ArrowRight') guideGo(-1);
    });
    // swipe between guide steps
    let sx = null, sy = null;
    root.addEventListener('touchstart', (e) => {
      const t = e.touches.length === 1 ? e.touches[0] : null;
      sx = t && state.guide != null ? t.clientX : null;
      sy = t && state.sheet && phone() && e.target.closest && e.target.closest('.grab,.hd') ? t.clientY : null;
    }, { passive: true });
    root.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      if (sy != null && t.clientY - sy > 48) { sy = null; state.sheet = false; emit(); return; }
      sy = null;
      if (sx == null || state.guide == null) return;
      const dx = t.clientX - sx;
      sx = null;
      if (Math.abs(dx) > 48) guideGo(dx > 0 ? 1 : -1);
    }, { passive: true });
    render();
  }
  const emit = () => { try { render(); } catch (e) { console.error('[yeghadam]', e); } };

  // Top edge of Snapp's bottom sheet: the outermost full-width box under the bottom of the screen that starts below
  // the top fifth of it. Falls back to half the screen.
  function sheetTop() {
    const w = window.innerWidth, h = window.innerHeight;
    let top = 0;
    for (let el = document.elementFromPoint(w / 2, h - 4); el && el !== document.body; el = el.parentElement) {
      if (el === host) return lastSheet || h / 2;
      const r = el.getBoundingClientRect();
      if (r.width >= w * 0.9 && r.top >= h * 0.2 && r.top < h - 60 && (!top || r.top < top)) top = r.top;
    }
    return top || h / 2;
  }
  let lastSheet = 0;
  function layout() {
    if (!host) return;
    const t = Math.round(sheetTop());
    if (Math.abs(t - lastSheet) < 2) return;
    lastSheet = t;
    host.style.setProperty('--sheet', t + 'px');
  }
  window.addEventListener('resize', () => layout());

  function render() {
    if (!root) return;
    let html;
    if (state.off) html = '';
    else if (state.intro != null) html = `<style>${CSS}</style><div class="w">${introHTML()}</div>`;
    else {
      const main = state.guide != null ? guideHTML() : state.sheet && !state.apply && !state.probe ? panelHTML() : pillHTML();
      const toast = state.toast ? `<div class="toast" role="status">${ICON.check}<span>${esc(state.toast)}</span></div>` : '';
      html = `<style>${CSS}</style><div class="w">${main}${state.guide != null ? '' : probeHTML() + applyHTML()}${toast}</div>`;
    }
    state.anim = false; // the panel's entrance plays once per opening
    if (html === lastHTML) return;
    const sc = root.querySelector('.bd'), top = sc ? sc.scrollTop : 0;
    const act = root.activeElement, focusId = act && act.id, caret = act && act.selectionStart;
    root.innerHTML = html;
    lastHTML = html;
    if (state.intro != null) { const b = root.getElementById('inext'); if (b) try { b.focus({ preventScroll: true }); } catch (e) {} }
    const s2 = root.querySelector('.bd');
    if (s2) s2.scrollTop = top;
    if (focusId) {
      const el = root.getElementById(focusId);
      if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch (e) {} }
    }
    positionTapHint();
  }

  const onPricePage = () => !!state.route && Date.now() - state.route.t < 30 * 60 * 1000;
  const resultFresh = () => state.result && state.result.base && Date.now() - state.result.at < 5 * 60 * 1000;

  // one-line status, shown in the collapsed pill and the panel header
  function status() {
    const r = state.result;
    if (state.running) {
      const done = r ? r.requests : 0, total = r && r.planned ? r.planned : 0;
      return { cls: '', spin: true, text: `در حال بررسی ${total ? fa(done) + ' از ' + fa(total) : '…'}` };
    }
    if (state.compat) return { cls: 'bad', text: 'یه‌قدم: نسخهٔ جدید لازمه' };
    if (state.error) return { cls: 'bad', text: 'یه‌قدم: خطا، بزن تا ببینی' };
    if (state.applied) return { cls: '', text: 'اعمال شد' };
    if (resultFresh()) {
      const top = currentCards();
      if (top.length) {
        const best = top.reduce((a, b) => (b.saving > a.saving ? b : a));
        return { cls: '', html: `<em>${toman(best.saving)}</em> ارزون‌تر، ${fa(best.c.walk)} متر پیاده` };
      }
      return { cls: 'plain', text: 'همین‌جا بهترینه' };
    }
    if (onPricePage()) return { cls: '', text: 'ارزون‌ترش کن' };
    return null;
  }
  function pillHTML() {
    if (state.apply || state.probe || !authHeader()) return '';
    const s = status();
    if (!s) return '';
    return `<button class="pill ${s.cls}" data-a="open" aria-label="باز کردن یه‌قدم">${s.spin ? '<span class="spin"></span>' : LOGO}<span>${s.html || esc(s.text)}</span></button>`;
  }

  function serviceSwitch(prices, names) {
    const ids = Object.keys(prices || {}).map(Number);
    if (ids.length < 2) return '';
    return `<div class="seg sm" role="group" aria-label="سرویس">${ids.map((id) => `<button class="${sid() === id ? 'on' : ''}" data-a="svc" data-k="${id}" aria-pressed="${sid() === id}">${esc(names[id] || id)}</button>`).join('')}</div>`;
  }

  function setupHTML() {
    const offered = bikeOffered() ? (state.snapp.categories || []).filter((c) => c.id === CAR || c.id === BIKE) : [];
    const cats = offered.length > 1 ? `<div class="seg sm" role="group" aria-label="نوع سفر">${offered.map((c) => `<button class="${cat() === c.id ? 'on' : ''}" data-a="cat" data-k="${c.id}" aria-pressed="${cat() === c.id}">${esc(c.name)}</button>`).join('')}</div>` : '';
    const sw = cat() === CAR && state.snapp ? serviceSwitch(state.snapp.prices, state.snapp.names) : '';
    const pick = cats || sw ? `<div class="lbl">مقایسه با</div>${cats}${sw}` : '';
    return `<div class="lbl">تا کجا حاضری پیاده بری؟</div>
      <div class="seg" role="group" aria-label="فاصلهٔ پیاده‌روی">${BUDGETS.map((b) => `<button class="${settings.budget === b ? 'on' : ''}" data-a="budget" data-k="${b}" aria-pressed="${settings.budget === b}">${fa(b)} متر</button>`).join('')}</div>
      <label class="lbl" for="cap">سقف قیمت <small>اختیاری</small></label>
      <div class="fld"><input id="cap" inputmode="numeric" autocomplete="off" enterkeyhint="search" placeholder="مثلاً ۱۶۰" value="${esc(state.capText)}"><span class="u">هزار تومان</span></div>
      ${pick}
      <div class="fine">${ICON.shield}<span>حدود ${fa(10)} ثانیه طول می‌کشه. فقط قیمت می‌پرسه؛ سفری ثبت نمی‌شه.</span></div>`;
  }
  const runButton = () => `<button class="btn" data-a="run" ${state.route ? '' : 'disabled'}>پیدا کن${ICON.next}</button>`;

  const KIND = { origin: 'مبدا', dest: 'مقصد', both: 'هر دو' };
  function placeShort(c) {
    if (c.kind === 'both') return `${placeText(c.origin)} / ${placeText(c.dest)}`;
    return placeText(c) + (c.twin ? ' (قیمت تازه)' : '');
  }
  function cardHTML(k, i) {
    const c = k.c, sel = c === state.selected ? ' sel' : '';
    return `<div class="card${sel}" data-a="pick" data-k="${esc(c.id)}" role="button" tabindex="0" aria-label="پیشنهاد ${fa(i + 1)}">
      <div class="c1"><span class="n">${fa(i + 1)}</span><span class="sv"><span>${toman(k.saving)} ارزون‌تر</span></span><span class="wk">${ICON.walk}${fa(c.walk)} متر</span></div>
      <div class="c2">${KIND_ICON[c.kind]}<span class="pl"><b>${KIND[c.kind]}:</b> ${esc(placeShort(c))}</span><span class="tag">${TAG[k.tag]}</span></div>
      <div class="c3"><span class="meta"><b>${toman(k.price)}</b></span>
        <button class="nb" data-a="dismiss" data-k="${esc(c.id)}" title="این پیشنهاد رو نشون نده">نمی‌رم</button><button class="go" data-a="apply" data-k="${esc(c.id)}">اعمال در اسنپ${ICON.next}</button></div>
    </div>`;
  }

  function resultHTML() {
    const r = state.result, s = sid();
    let h = '';
    const bp = C.priceOf(r.base, s);
    const age = state.running ? 0 : Math.floor((Date.now() - r.at) / 60000);
    const sw = serviceSwitch(r.base.prices, r.names);
    h += `<div class="now">${sw}<div class="base"><small>قیمت الان</small><b>${toman(bp)}</b></div></div>`;
    if (age >= 5) h += note('w', `این قیمت‌ها مال ${fa(age)} دقیقه پیشه و احتمالاً عوض شده. <button class="lnk" data-a="run">دوباره بگرد</button>`, ICON.clock);
    else if (age >= 1) h += `<div class="age">قیمت‌ها مال ${fa(age)} دقیقه پیش.</div>`;
    if (r.drift && Math.abs(r.drift) >= C.MIN_SAVING) {
      h += note('w', `قیمت اسنپ وسط جستجو ${toman(Math.abs(r.drift))} ${r.drift > 0 ? 'گرون' : 'ارزون'} شد. <button class="lnk" data-a="run">دوباره بگرد</button>`);
    }
    if (r.baseLock && r.twin) {
      const left = Math.round(r.baseLock.left - (Date.now() - r.baseLock.at) / 1000);
      const now = C.priceOf(r.twin, s);
      if (left > 0 && now - bp >= C.MIN_SAVING) {
        h += note('ok', `قیمتت قفل شده و از قیمت لحظه‌ای (${toman(now)}) ارزون‌تره. تا ${fa(Math.ceil(left / 60))} دقیقهٔ دیگه همینه؛ جابجا کردن پین قیمت تازه می‌گیره.`, ICON.lock);
      } else if (bp - now >= C.MIN_SAVING) {
        h += note('ok', `قیمت لحظه‌ای از قیمت قفل‌شده‌ات ارزون‌تر شده؛ یه جابجایی کوتاه پین قیمت تازه می‌گیره.`, ICON.lock);
      }
    }
    if (r.approx.origin || r.approx.dest) h += note('w', 'نقشهٔ خیابان‌ها این‌جا نیومد؛ فاصله‌ها خط هوایی‌ان. قبل از اعمال روی نقشه ببین.');
    h += capHTML(r, s, bp);
    const cs = C.cards(r, s);
    if (cs.length) h += cs.map(cardHTML).join('');
    else if (!state.running) {
      const n = r.origins.length + r.dests.length;
      const spread = r.origins.concat(r.dests).filter((c) => isFinite(C.priceOf(c, s))).reduce((m, c) => Math.max(m, Math.abs(C.priceOf(c, s) - bp)), 0);
      const why = spread < 2 * C.MIN_SAVING ? ' این ساعت قیمت نقاط اطراف تقریباً یکیه؛ ساعت‌های شلوغ معمولاً تفاوت بیشتره.' : '';
      h += note('ok', `<b>همین‌جا بهترینه.</b> ${fa(n)} نقطه تا ${fa(r.budget)} متر بررسی شد و هیچ‌کدوم دست‌کم ۱٬۰۰۰ تومان ارزون‌تر نبود.${why}`);
    }
    return h;
  }

  // The price limit does not cut the search short; it answers one question about the full result:
  // what is the shortest walk that gets the price under your limit?
  function capHTML(r, s, bp) {
    const cap = parseToman(state.capText) * 10;
    if (!cap || state.running) return '';
    if (bp <= cap) return note('ok', `همین الان زیر ${toman(cap)} هستی؛ لازم نیست جابجا شی.`);
    const list = r.origins.concat(r.dests, r.combo ? [r.combo] : []).filter((c) => !c.dismissed && C.priceOf(c, s) <= cap);
    if (!list.length) {
      const near = C.nearestToCap(r, s);
      return note('w', `تا ${fa(r.budget)} متر هیچ نقطه‌ای زیر ${toman(cap)} نبود${near ? `؛ ارزون‌ترین ${toman(C.priceOf(near, s))} با ${fa(near.walk)} متر پیاده` : ''}.`);
    }
    const best = list.sort((a, b) => a.walk - b.walk || C.priceOf(a, s) - C.priceOf(b, s))[0];
    return note('ok', `کمترین پیاده‌روی برای زیر ${toman(cap)}: <b>${fa(best.walk)} متر</b> (${toman(C.priceOf(best, s))}). <button class="lnk" data-a="pick" data-k="${esc(best.id)}">نشونم بده</button>`);
  }

  /* ---------------- first run ---------------- */
  // Full-screen navy, like the app's banners: one idea per screen, a big headline with one lime word.
  const NOTICE = [
    [ICON.info, 'یه‌قدم برنامهٔ رسمی اسنپ نیست و هیچ ربطی به اسنپ نداره.'],
    [ICON.shield, 'با حساب خودت و روی دستگاه خودت فقط از اسنپ قیمت می‌پرسه. هیچ‌وقت سفر درخواست یا لغو نمی‌کنه و اطلاعاتت رو جای دیگه‌ای نمی‌فرسته.'],
    [ICON.check, 'قیمت نهایی همونیه که خود اسنپ موقع درخواست سفر نشون می‌ده.'],
    [ICON.alert, 'بعیده، ولی ممکنه اسنپ استعلام خودکار رو خلاف قوانینش بدونه و حسابت رو محدود کنه. استفاده با مسئولیت خودته.'],
  ];
  const introArt = () => `<rect width="320" height="190" fill="#1d2240"/><path d="M0 92H320" stroke="#262c4d" stroke-width="18"/><path d="M110 0V190M228 0V190" stroke="#262c4d" stroke-width="10"/>
    <path d="M78 92H194" stroke="#fff" stroke-opacity=".6" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="0.5 8"/>
    <circle cx="62" cy="92" r="12" fill="#1d2240" stroke="#fff" stroke-width="3.5"/><circle cx="212" cy="92" r="15" fill="#c5f04a"/>
    <g transform="translate(62 50)"><rect x="-40" y="-16" width="80" height="30" rx="10" fill="#262c4d"/>${T(0, 5, fa(85000), 13, 700, '#b8bdd0')}<path d="M-26 0H26" stroke="#b8bdd0" stroke-width="1.5"/></g>
    <g transform="translate(212 48)"><rect x="-46" y="-17" width="92" height="32" rx="11" fill="#c5f04a"/>${T(0, 5, fa(72000), 14, 800, '#15192e')}</g>
    <g transform="translate(137 122)"><rect x="-32" y="-13" width="64" height="22" rx="11" fill="#262c4d"/>${T(0, 3, fa(40) + ' متر', 11, 700, '#e4e7f1')}</g>
    <g transform="translate(160 162)"><rect x="-128" y="-17" width="256" height="34" rx="17" fill="#15192e" stroke="#2f3658"/><text y="5" font-size="12.5" font-weight="700" fill="#fff" text-anchor="middle" direction="rtl" unicode-bidi="embed" font-family="${FONT}">${toman(130000)} ارزون‌تر، ${fa(40)} متر پیاده</text></g>`;
  function introHTML() {
    const notice = state.intro === 1;
    const dots = state.review ? '' : `<span class="dots" aria-label="صفحهٔ ${fa(state.intro + 1)} از ${fa(2)}"><i class="${notice ? '' : 'on'}"></i><i class="${notice ? 'on' : ''}"></i></span>`;
    const body = notice
      ? `<h1 id="it">قبل از شروع،<br><em>اینو بدون</em></h1><ul class="il">${NOTICE.map(([ic, t]) => `<li><i>${ic}</i><span>${t}</span></li>`).join('')}</ul>`
      : `<h1 id="it">یه قدم راه برو،<br><em>ارزون‌تر</em> سوار شو</h1>
        <p>یه‌قدم چند نقطهٔ نزدیکت رو از خود اسنپ قیمت می‌گیره و ارزون‌ترها رو نشونت می‌ده: چقدر ارزون‌تر و چند متر پیاده. تصمیم با خودته.</p>
        <div class="iart"><svg viewBox="0 0 320 190" direction="ltr" aria-hidden="true">${introArt()}</svg></div>`;
    const acts = !notice ? `<button class="btn lime" id="inext" data-a="introNext">بعدی${ICON.next}</button>`
      : state.review ? `<button class="btn lime" id="inext" data-a="reviewClose">بستن</button>`
      : `<button class="btn lime" id="inext" data-a="accept">فهمیدم، قبول دارم</button><button class="itx" data-a="decline">نه، ممنون</button>`;
    return `<div class="io" role="dialog" aria-modal="true" aria-labelledby="it"><div class="glow"></div><div class="icol">
      <div class="ib">${LOGO}<b>یه‌قدم</b><span class="sp"></span><span class="ichip">غیررسمی</span></div>
      <div class="imain${notice ? ' note-page' : ''}">${body}</div><div class="iact">${dots}${acts}</div></div></div>`;
  }
  function acceptNotice() {
    try { localStorage.setItem(CONSENT_KEY, JSON.stringify({ v: NOTICE_V, at: Date.now() })); } catch (e) {}
    try { if (NATIVE && NATIVE.setConsent) NATIVE.setConsent(NOTICE_V); } catch (e) {}
    settings.seenIntro = true; saveSettings();
    state.intro = null; introOpen(false); emit();
  }
  // Android closes the app and asks again next time; in the browser the page stays plain Snapp until it reloads.
  function declineNotice() {
    try { if (NATIVE && NATIVE.decline) { NATIVE.decline(); return; } } catch (e) {}
    state.intro = null; state.off = true; introOpen(false); emit();
  }

  /* ---------------- guide ---------------- */
  // Six short steps, each drawn with the same parts the rider will see: Snapp's map, our pill, panel and cards.
  const T = (x, y, s, size, weight, fill, anchor) => `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor || 'middle'}" font-family="${FONT}">${s}</text>`;
  const MAPBG = `<rect width="320" height="170" fill="#eceee6"/><g fill="#e0e3d8"><rect x="12" y="10" width="86" height="54" rx="6"/><rect x="118" y="10" width="92" height="54" rx="6"/><rect x="230" y="10" width="80" height="54" rx="6"/><rect x="12" y="96" width="86" height="66" rx="6"/><rect x="118" y="96" width="92" height="66" rx="6"/><rect x="230" y="96" width="80" height="66" rx="6"/></g><path d="M0 80H320" stroke="#fff" stroke-width="16"/><path d="M108 0V170M220 0V170" stroke="#fff" stroke-width="9"/>`;
  const SNAPPIN = (x, y) => `<path d="M${x} ${y}c-9-11-14-18-14-25a14 14 0 0 1 28 0c0 7-5 14-14 25z" fill="#15192e"/><circle cx="${x}" cy="${y - 25}" r="5" fill="#fff"/>`;
  const GUIDE = [
    { t: 'یه قدم اون‌ورتر، ارزون‌تر',
      d: 'قیمت اسنپ برای دو نقطهٔ نزدیک به هم گاهی چند هزار تومان فرق داره. یه‌قدم نقطه‌های اطراف مبدا و مقصدت رو قیمت می‌گیره و ارزون‌ترها رو نشونت می‌ده.',
      art: () => `${MAPBG}<path d="M72 80H172" stroke="#15192e" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="0.5 8"/><circle cx="58" cy="80" r="11" fill="#fff" stroke="#15192e" stroke-width="3.5"/><circle cx="188" cy="80" r="13" fill="#c5f04a" stroke="#15192e" stroke-width="2.5"/>
        <g transform="translate(58 42)"><rect x="-38" y="-16" width="76" height="30" rx="10" fill="#fff" stroke="#d9dce4"/>${T(0, 5, fa(85000), 13, 700, '#636982')}<path d="M-24 0H24" stroke="#636982" stroke-width="1.5"/></g>
        <g transform="translate(188 40)"><rect x="-44" y="-17" width="88" height="32" rx="11" fill="#15192e"/>${T(0, 5, fa(72000), 14, 800, '#c5f04a')}</g>
        <g transform="translate(122 106)"><rect x="-30" y="-13" width="60" height="22" rx="11" fill="#fff"/>${T(0, 3, fa(40) + ' متر', 11, 700, '#3a4058')}</g>` },
    { t: 'اول مسیرت رو توی اسنپ بزن',
      d: 'مبدا و مقصد رو مثل همیشه انتخاب کن. وقتی قیمت‌ها اومد، دکمهٔ «ارزون‌ترش کن» بالای قیمت‌ها پیدا می‌شه؛ روش بزن.',
      art: () => `${MAPBG}<path d="M276 104V80H220V30" fill="none" stroke="#4f6bed" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="276" cy="104" r="8" fill="#15192e"/><circle cx="276" cy="104" r="3.5" fill="#fff"/>${SNAPPIN(220, 32)}
        <rect x="0" y="126" width="320" height="60" rx="18" fill="#fff"/><rect x="146" y="138" width="158" height="10" rx="5" fill="#e7e9ef"/><rect x="16" y="138" width="70" height="10" rx="5" fill="#e7e9ef"/><rect x="186" y="156" width="118" height="8" rx="4" fill="#f2f3f7"/>
        <g transform="translate(14 88)"><rect width="134" height="30" rx="15" fill="#15192e"/><rect x="4" y="4" width="22" height="22" rx="6" fill="#2a3050"/><circle cx="11.3" cy="18.5" r="2.4" fill="none" stroke="#fff" stroke-width="1.2"/><circle cx="18.6" cy="12" r="4.2" fill="#c5f04a"/>${T(80, 20, 'ارزون‌ترش کن', 12, 800, '#fff')}</g>
        <circle class="pulse" cx="110" cy="103" r="16" fill="none" stroke="#c5f04a" stroke-width="3"/>` },
    { t: 'بگو تا کجا پیاده میای',
      d: '۱۰۰، ۲۰۰ یا ۳۰۰ متر. اگه سقف قیمت داری بنویسش تا بگه با کمترین پیاده‌روی کجا زیرش می‌شه. بعد «پیدا کن»؛ حدود ۱۰ ثانیه طول می‌کشه.',
      art: () => `<rect width="320" height="170" fill="#f2f3f7"/><rect x="20" y="20" width="280" height="40" rx="13" fill="#e6e8ee"/><rect x="116" y="23" width="88" height="34" rx="10" fill="#15192e"/>
        ${T(254, 45, fa(100) + ' متر', 12.5, 700, '#3a4058')}${T(160, 45, fa(200) + ' متر', 12.5, 800, '#fff')}${T(66, 45, fa(300) + ' متر', 12.5, 700, '#3a4058')}
        <rect x="20" y="72" width="280" height="38" rx="12" fill="#fff" stroke="#e3e5ec" stroke-width="1.5"/>${T(286, 96, 'سقف قیمت، مثلاً ' + fa(160), 12, 500, '#636982', 'end')}${T(34, 96, 'هزار تومان', 11.5, 500, '#636982', 'start')}
        <rect x="20" y="122" width="280" height="38" rx="13" fill="#15192e"/>${T(168, 146, 'پیدا کن', 13.5, 800, '#fff')}<path d="M138 141h-12m5-5-5 5 5 5" fill="none" stroke="#c5f04a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` },
    { t: 'پیشنهادها رو مقایسه کن',
      d: 'هر کارت می‌گه چقدر ارزون‌تر، چند متر پیاده و کجا. همون شماره روی نقشه هم هست و خط‌چین، راه پیاده‌روی رو نشون می‌ده.',
      art: () => `${MAPBG}<circle cx="60" cy="80" r="6" fill="#94a3b8" stroke="#fff" stroke-width="2"/><circle cx="262" cy="80" r="6" fill="#dc2626" stroke="#fff" stroke-width="2"/><circle cx="108" cy="122" r="6" fill="#dc2626" stroke="#fff" stroke-width="2"/><circle cx="220" cy="128" r="6" fill="#94a3b8" stroke="#fff" stroke-width="2"/>
        <path d="M200 80H160" stroke="#15192e" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="0.5 7"/>${SNAPPIN(200, 80)}
        <circle cx="148" cy="80" r="13" fill="#c5f04a" stroke="#15192e" stroke-width="2.5"/>${T(148, 85, fa(1), 13, 800, '#15192e')}<circle cx="246" cy="36" r="12" fill="#fff" stroke="#15192e" stroke-width="2.5"/>${T(246, 41, fa(2), 12.5, 800, '#15192e')}
        <rect x="10" y="140" width="300" height="24" rx="12" fill="#fff"/><circle cx="296" cy="152" r="5" fill="#65a30d"/>${T(287, 156, 'ارزون‌تر', 11, 700, '#3a4058', 'end')}<circle cx="196" cy="152" r="5" fill="#dc2626"/>${T(187, 156, 'گرون‌تر', 11, 700, '#3a4058', 'end')}<circle cx="100" cy="152" r="5" fill="#94a3b8"/>${T(91, 156, 'فرقی نداره', 11, 700, '#3a4058', 'end')}` },
    { t: 'اعمال کن، بعد پیاده برو',
      d: 'با «اعمال در اسنپ» پین خودش می‌ره سر نقطهٔ جدید؛ تو فقط روی پین بزن تا اسنپ تأییدش کنه. پیشنهادی رو نمی‌خوای؟ «نمی‌رم» رو بزن.',
      art: () => `${MAPBG}<circle class="pulse" cx="160" cy="80" r="30" fill="none" stroke="#c5f04a" stroke-width="3.5"/>${SNAPPIN(160, 80)}
        <g transform="translate(16 12)"><rect width="288" height="32" rx="11" fill="#15192e"/>${T(274, 21, 'روی پین اسنپ بزن تا تأیید شه', 12, 700, '#fff', 'end')}<circle cx="18" cy="16" r="5" fill="#c5f04a"/></g>
        <g transform="translate(174 88) scale(1.7)" fill="none" stroke="#15192e" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></g>` },
    { t: 'خیالت راحت',
      list: () => [
        [ICON.shield, 'فقط از خود اسنپ قیمت می‌پرسه و هیچ‌وقت سفر درخواست نمی‌ده. اطلاعات حسابت به هیچ سرور دیگه‌ای نمی‌ره.'],
        [ICON.clock, 'برای امنیت حسابت، چند جستجو در هر ۱۰ دقیقه بیشتر انجام نمی‌ده.'],
        [ICON.hand, `قیمت یه نقطهٔ دلخواه رو می‌خوای؟ روی نقشه ${TOUCH ? 'انگشتت رو نگه دار' : 'کلیک راست کن'}.`],
      ],
      art: () => `<rect width="320" height="170" fill="#f2f3f7"/><circle cx="160" cy="85" r="62" fill="#e6e8ee"/>
        <g transform="translate(124 46) scale(3)"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" fill="#15192e"/><path d="m9 12 2 2 4-4" fill="none" stroke="#c5f04a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>
        <g transform="translate(62 46)"><rect x="-50" y="-15" width="100" height="28" rx="14" fill="#fff"/>${T(0, 4, 'فقط استعلام قیمت', 11, 700, '#15192e')}</g>
        <g transform="translate(258 124)"><rect x="-52" y="-15" width="104" height="28" rx="14" fill="#fff"/>${T(0, 4, 'بدون درخواست سفر', 11, 700, '#15192e')}</g>` },
  ];
  function guideHTML() {
    const i = state.guide, g = GUIDE[i], last = i === GUIDE.length - 1;
    const body = g.list
      ? `<ul class="gl">${g.list().map(([ic, s]) => `<li>${ic}<span>${s}</span></li>`).join('')}</ul><div class="fine">${ICON.info}<span>برنامهٔ غیررسمی؛ ربطی به اسنپ نداره. <button class="lnk" data-a="terms">شرایط استفاده</button></span></div>`
      : `<p>${g.d}</p>`;
    return `<div class="gd" data-a="guideOut"><div class="gs" role="dialog" aria-modal="true" aria-labelledby="gt">
      <div class="gtop">${LOGO}<span class="name">راهنمای یه‌قدم</span><span class="sp"></span><button class="ic" data-a="guideSkip" aria-label="بستن راهنما" title="بستن">${ICON.close}</button></div>
      <div class="art"><svg viewBox="0 0 320 170" direction="ltr" aria-hidden="true">${g.art()}</svg></div>
      <div class="gtx"><h2 id="gt">${g.t}</h2>${body}</div>
      <div class="gnav"><span class="dots" aria-label="قدم ${fa(i + 1)} از ${fa(GUIDE.length)}">${GUIDE.map((_, j) => `<i class="${j === i ? 'on' : ''}"></i>`).join('')}</span>
        ${i > 0 ? `<button class="btn ghost" data-a="guidePrev" aria-label="قبلی">${ICON.prev}</button>` : ''}
        <button class="btn" id="gnext" data-a="guideNext">${last ? 'شروع کن' : 'بعدی'}${ICON.next}</button></div>
    </div></div>`;
  }
  function guideGo(step) {
    const i = state.guide + step;
    if (i < 0) return;
    if (i >= GUIDE.length) { closeGuide(); return; }
    state.guide = i; emit();
  }
  function closeGuide() {
    state.guide = null; settings.seenGuide = true; saveSettings();
    state.sheet = true; state.anim = true;
    emit();
  }

  function panelHTML() {
    const r = state.result, st = status();
    let h = `<div class="pn${state.anim ? ' in' : ''}" role="dialog" aria-label="یه‌قدم"><button class="grab" data-a="close" aria-label="جمع کن"><i></i></button><div class="hd">${LOGO}<span class="name">یه‌قدم</span><span class="unoff">غیررسمی</span><span class="sp"></span>
      ${st && st.spin ? '<span class="spin"></span>' : ''}<button class="ic" data-a="guide" title="راهنما" aria-label="راهنما">${ICON.help}</button><button class="ic" data-a="close" title="جمع کن" aria-label="جمع کن">${phone() ? ICON.down : ICON.collapse}</button></div>`;
    if (state.running) {
      const done = r ? r.requests : 0, total = r && r.planned ? r.planned : 23;
      h += `<div class="bar"><i style="transform:scaleX(${(done / Math.max(1, total)).toFixed(3)})"></i></div>`;
    }
    h += '<div class="bd">';
    let dock = '';
    if (state.compat) h += note('e', ERR.changed);
    if (!authHeader()) h += note('w', 'اول وارد حساب اسنپت شو.');
    else if (!state.route) h += note('i', 'مبدا و مقصد رو توی اسنپ انتخاب و تأیید کن تا قیمت بیاد؛ بعد همین‌جا ارزون‌ترش می‌کنیم.');
    if (state.running) {
      const done = r ? r.requests : 0, total = r && r.planned ? r.planned : 23;
      h += `<div class="run" role="status" aria-live="polite"><div><b>بررسی ${fa(done)} از ${fa(total)} نقطه</b><small>تا ${fa(settings.budget)} متر پیاده، با حساب خودت</small></div></div>`;
      if (r && r.base) h += resultHTML();
      dock = `<button class="btn ghost" data-a="stop">توقف</button>`;
    } else if (state.error) {
      h += note('e', errText(state.error));
      if (r && r.base) h += resultHTML();
      h += setupHTML();
      dock = runButton();
    } else if (r && r.base && !state.setup) {
      h += resultHTML();
      h += `<div class="foot"><button class="tb" data-a="setup">${ICON.again}جستجوی دوباره</button>
        <div class="fine">${ICON.hand}<span>قیمت هر نقطه: روی نقشه ${TOUCH ? 'انگشتت رو نگه دار' : 'کلیک راست کن'}.</span></div></div>`;
    } else if (state.route) {
      h += setupHTML();
      dock = runButton();
    }
    h += '</div>';
    if (dock) h += `<div class="dock">${dock}</div>`;
    return h + '</div>';
  }

  function probeHTML() {
    const p = state.probe;
    if (!p || state.apply) return '';
    const s = sid(), lbl = LABEL[p.kind];
    let body;
    if (p.loading) body = `<div class="msg"><span class="spin"></span>دارم قیمت این نقطه رو می‌گیرم…</div>`;
    else if (p.error) body = `<div class="msg">${errText(p.error)}</div>`;
    else {
      const price = C.priceOf(p, s), ref = p.base ? p.base[s] : NaN, d = price - ref;
      const delta = isFinite(d) && Math.abs(d) >= 10 ? `<span class="dl ${d < 0 ? 'dn' : 'up'}">${toman(Math.abs(d))} ${d < 0 ? 'ارزون‌تر' : 'گرون‌تر'}</span>` : '';
      body = `<div class="big"><b>${toman(price)}</b>${delta}</div><div class="sub">حدود ${fa(p.walk)} متر ${p.dir} (خط هوایی)</div>`;
    }
    const canApply = !p.loading && !p.error && p.prices;
    return `<div class="ab" role="status"><div class="top">${ICON.pin}<span>قیمت این نقطه به‌عنوان ${lbl}</span></div>${body}
      <div class="acts">${canApply ? `<button class="go" data-a="applyProbe">اعمال در اسنپ${ICON.next}</button>` : ''}<button class="nb" data-a="closeProbe">بستن</button></div></div>`;
  }

  function applyHTML() {
    const a = state.apply;
    if (!a) return '';
    const s = a.steps[a.i], lbl = LABEL[s.kind];
    const steps = a.steps.length > 1 ? `<span class="steps" aria-label="مرحلهٔ ${fa(a.i + 1)} از ${fa(a.steps.length)}">${a.steps.map((_, j) => `<i class="${j === a.i ? 'on' : ''}"></i>`).join('')}</span>` : '';
    let msg = '', acts = '';
    if (a.phase === 'fly') msg = `<div class="msg"><span class="spin"></span>دارم پین ${lbl} رو می‌برم سر نقطهٔ ارزون‌تر…</div>`;
    else if (a.phase === 'confirm') msg = `<div class="msg"><span>روی <b>پین اسنپ</b> بزن تا ${lbl} جدید تأیید شه.</span></div><div class="sub">همون پینی که وسط دایرهٔ سبز چشمک می‌زنه.</div>`;
    else {
      msg = `<div class="msg">برچسب «${lbl}» روی نقشه پیدا نشد.</div><div class="sub">خودت روی «${lbl}» روی نقشه بزن، بعد «ادامه» رو بزن.</div>`;
      acts = `<button class="go" data-a="manualGo">ادامه${ICON.next}</button>`;
    }
    return `<div class="ab" role="status"><div class="top">${KIND_ICON[s.kind]}<span class="t">${esc(lbl + ': ' + placeText(s.c))}</span><span class="sp"></span>${steps}</div>${msg}
      <div class="acts">${acts}<button class="nb" data-a="cancelApply">لغو</button></div></div>
      ${a.phase === 'confirm' ? '<div class="ring" id="ring"></div>' : ''}`;
  }

  function positionTapHint() {
    if (!root) return;
    const ring = root.getElementById && root.getElementById('ring');
    if (!ring || !state.apply || !state.map) return;
    try {
      const c = state.map.getCenter(), pt = state.map.project([c.lng, c.lat]);
      const rect = state.map.getContainer().getBoundingClientRect();
      ring.style.left = rect.left + pt.x + 'px';
      ring.style.top = rect.top + pt.y + 'px';
    } catch (e) {}
  }

  function findById(id) {
    if (!id) return null;
    const r = state.result;
    if (r && r.combo && r.combo.id === id) return r.combo;
    return allQuoted().find((c) => c.id === id) || null;
  }
  function startRun() { state.error = null; state.result = null; run(); }

  function onClick(e) {
    const t = e.target.closest('[data-a]');
    if (!t) return;
    const a = t.dataset.a, k = t.dataset.k;
    if (a === 'introNext') { state.intro = 1; settings.seenIntro = true; saveSettings(); emit(); return; }
    if (a === 'accept') { acceptNotice(); return; }
    if (a === 'decline') { declineNotice(); return; }
    if (a === 'terms') { state.guide = null; state.intro = 1; state.review = true; emit(); return; }
    if (a === 'reviewClose') { state.intro = null; state.review = false; state.sheet = true; emit(); return; }
    if (a === 'guideOut' && e.target !== t) return; // a tap inside the guide sheet, not on the backdrop
    if (a === 'open') { state.sheet = true; state.anim = true; if (!settings.seenGuide && state.guide == null) state.guide = 0; emit(); }
    else if (a === 'close') { state.sheet = false; emit(); }
    else if (a === 'stop') state.cancel = true;
    else if (a === 'guide') { state.guide = 0; emit(); }
    else if (a === 'guideNext') guideGo(1);
    else if (a === 'guidePrev') guideGo(-1);
    else if (a === 'guideSkip' || a === 'guideOut') closeGuide();
    else if (a === 'run') startRun();
    else if (a === 'setup') { state.setup = true; emit(); }
    else if (a === 'budget') { settings.budget = +k; saveSettings(); emit(); }
    else if (a === 'cat') {
      if (cat() === +k) return;
      settings.category = +k; saveSettings();
      if (state.running) state.cancel = true;
      state.result = null; state.resultKey = ''; state.selected = null; state.error = null; state.setup = true;
      emit(); drawMap();
    }
    else if (a === 'svc') { settings.services[cat()] = +k; saveSettings(); const top = currentCards()[0]; state.selected = top ? top.c : null; emit(); drawMap(); }
    else if (a === 'pick') {
      const c = findById(k);
      if (!c) return;
      state.selected = c;
      drawMap(); emit(); moveMapTo(c.kind === 'both' ? c.dest : c, null, true);
    } else if (a === 'apply') {
      e.stopPropagation();
      const c = findById(k);
      if (c) startApply(c);
    } else if (a === 'dismiss') {
      e.stopPropagation();
      const c = findById(k);
      if (c) { c.dismissed = true; if (state.selected === c) { const top = currentCards()[0]; state.selected = top ? top.c : null; } emit(); drawMap(); }
    } else if (a === 'applyProbe') { if (state.probe) startApply(state.probe); }
    else if (a === 'closeProbe') { state.probe = null; emit(); drawMap(); }
    else if (a === 'manualGo') continueManual();
    else if (a === 'cancelApply') cancelApply();
  }
  function onInput(e) {
    if (e.target.id === 'cap') state.capText = e.target.value; // no re-render while typing
  }

  // Android back button: close this UI first.
  window.__yeghadamBack = function () {
    if (state.review) { state.intro = null; state.review = false; emit(); return true; }
    if (state.intro === 1 && state.fromIntro) { state.intro = 0; emit(); return true; }
    if (state.intro != null) { declineNotice(); return true; } // back never walks past the notice
    if (state.guide != null) { closeGuide(); return true; }
    if (state.apply) { cancelApply(); return true; }
    if (state.probe) { state.probe = null; emit(); drawMap(); return true; }
    if (state.sheet) { state.sheet = false; emit(); return true; }
    return false;
  };

  if (state.intro != null) introOpen(true);
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  // If the site changes its markers or its price requests, the route is never confirmed. Say so plainly instead of
  // offering a search that cannot work.
  function checkCompat() {
    const last = recent[recent.length - 1];
    const markers = document.querySelectorAll('.mapboxgl-marker').length;
    const stuck = !!last && !state.route && state.map && markers >= 2 && Date.now() - last.t > 20000;
    if (stuck !== !!state.compat) { state.compat = stuck; emit(); }
  }

  setInterval(() => {
    if (!host) mount();
    else if (!document.contains(host) && document.body) document.body.appendChild(host);
    syncRoute(); // markers settle after Snapp's request returns
    checkCompat();
    layout();
    emit();
  }, 1500);

  window.__yeghadamDebug = { state, settings: () => settings, run, findSnappLabel, core: C, allQuoted };
})();
