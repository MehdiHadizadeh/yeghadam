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
  const defaults = { budget: 200, category: CAR, services: {} };
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
    if (state.running || !state.route) return;
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
    if (!ll || !state.route || state.running || state.apply) return;
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
        if (c && !state.apply) { state.selected = c; state.sheet = true; state.setup = false; drawMap(); emit(); }
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
      el.style.cssText = `width:28px;height:28px;border-radius:50%;box-sizing:border-box;border:2px solid #15192e;background:${on ? '#c5f04a' : '#fff'};color:#15192e;font:700 14px/24px ${FONT};text-align:center;box-shadow:0 2px 8px rgba(2,6,23,.3);cursor:pointer`;
      el.addEventListener('click', (e) => { e.stopPropagation(); state.selected = w.card; state.sheet = true; state.setup = false; drawMap(); emit(); });
      badges.push(new mb.Marker({ element: el, anchor: 'bottom', offset: [0, -8] }).setLngLat([w.at.lng, w.at.lat]).addTo(map));
    }
  }
  function moveMapTo(c, ms) {
    if (!state.map || !c) return false;
    state.map.easeTo({ center: [c.lng, c.lat], zoom: Math.max(state.map.getZoom(), 16.5), duration: ms == null ? 700 : ms });
    return true;
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
    notify('اعمال شد. قیمت جدید رو توی اسنپ ببین.');
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

  const ICON = {
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>',
  };

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box;font-family:${FONT};-webkit-tap-highlight-color:transparent;margin:0}
  .w{direction:rtl;color:#0f172a;font-size:14px;line-height:1.65;font-family:${FONT}}
  button{font:inherit;cursor:pointer}
  .lg{width:22px;height:22px;flex:none;display:block}
  /* --sheet is the top edge of Snapp's bottom sheet (prices, ride button), measured at run time: stay above it */
  .pn{position:fixed;top:calc(env(safe-area-inset-top,0px) + 60px);left:10px;z-index:2147483000;width:min(380px,calc(100vw - 20px));
    background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(2,6,23,.18),0 1px 3px rgba(2,6,23,.12);overflow:hidden;
    display:flex;flex-direction:column;max-height:calc(var(--sheet,50vh) - 70px - env(safe-area-inset-top,0px));min-height:150px}
  .pill{position:fixed;top:calc(var(--sheet,50vh) - 54px);left:10px;z-index:2147483000;display:flex;align-items:center;gap:8px;max-width:calc(100vw - 20px);
    background:#fff;color:#0f172a;border:0;border-radius:999px;padding:7px 14px 7px 8px;font-size:13.5px;font-weight:700;box-shadow:0 6px 18px rgba(2,6,23,.18)}
  .pill.good{background:#15192e;color:#fff}
  .pill.good .lg rect{fill:#2a3050}
  .pill.bad{background:#b91c1c;color:#fff}
  .hd{display:flex;align-items:center;gap:8px;padding:6px 6px 6px 10px;border-bottom:1px solid #f1f5f9}
  .hd b{font-size:14.5px}
  .hd .sp{flex:1}
  .ic{display:grid;place-items:center;border:0;background:transparent;border-radius:10px;width:36px;height:36px;color:#475569}
  .ic:hover{background:#f1f5f9}
  .ic svg,.x svg{width:18px;height:18px}
  .bd{flex:1;min-height:0;overflow:auto;padding:8px 10px 10px;overscroll-behavior:contain;scrollbar-width:thin}
  .muted{color:#64748b;font-size:12.5px}
  .q{font-weight:700;margin:2px 0 8px}
  .seg{display:flex;gap:6px}
  .seg button{flex:1;min-height:40px;border:1.5px solid #e2e8f0;background:#fff;color:#0f172a;border-radius:12px;font-weight:700}
  .seg button.on{border-color:#15192e;background:#f6fbe6;color:#15192e}
  .seg.sm button{min-height:32px;font-size:12.5px;border-radius:10px}
  .cap{display:flex;align-items:center;gap:8px;margin-top:10px}
  .cap input{flex:1;min-width:0;font:inherit;font-size:14px;min-height:40px;padding:6px 12px;border:1.5px solid #e2e8f0;border-radius:12px;direction:rtl;color:#0f172a;background:#fff}
  .cap input:focus{outline:none;border-color:#15192e}
  .btn{display:block;width:100%;border:0;border-radius:12px;min-height:44px;font-size:15px;font-weight:700;background:#15192e;color:#fff;margin-top:12px}
  .btn.ghost{background:#f1f5f9;color:#0f172a;margin-top:8px;min-height:40px;font-size:14px}
  .btn:disabled{background:#94a3b8}
  .bar{height:4px;background:#e2e8f0;overflow:hidden}
  .bar i{display:block;height:100%;width:100%;background:#15192e;transform-origin:right;transition:transform .25s ease-out}
  .now{display:flex;align-items:center;gap:8px;margin-bottom:6px}
  .now .seg{flex:1}
  .now b{font-size:14px;white-space:nowrap}
  .card{border:1.5px solid #e2e8f0;border-radius:12px;padding:7px 6px 7px 10px;margin-top:6px;cursor:pointer}
  .card.sel{border-color:#15192e;background:#fafdf1}
  .r1{display:flex;align-items:center;gap:8px}
  .x{display:grid;place-items:center;border:0;background:transparent;border-radius:8px;width:30px;height:30px;color:#94a3b8;flex:none}
  .x:hover{background:#f1f5f9;color:#475569}
  .n{width:24px;height:24px;flex:none;border-radius:50%;border:2px solid #15192e;color:#15192e;background:#fff;font-weight:800;font-size:13px;line-height:20px;text-align:center}
  .card.sel .n{background:#c5f04a;color:#15192e}
  .sv{font-size:15.5px;font-weight:800;color:#3f6212;flex:1;white-space:nowrap}
  .r2{font-size:12.5px;margin-top:2px;color:#475569;padding-inline-start:32px}
  .r2 b{color:#0f172a}
  .k{display:inline-block;font-size:11.5px;font-weight:700;border-radius:6px;padding:0 6px;margin-inline-end:4px}
  .k.origin{background:#e0f2fe;color:#075985}.k.dest{background:#fef3c7;color:#92400e}.k.both{background:#ede9fe;color:#5b21b6}
  .go{border:0;border-radius:10px;min-height:32px;padding:0 12px;font-size:13px;font-weight:700;background:#15192e;color:#fff;flex:none}
  .nb{border:0;border-radius:10px;min-height:36px;padding:0 10px;font-size:13px;font-weight:700;background:#f1f5f9;color:#475569}
  .note{background:#f4f7ec;border-radius:10px;padding:8px 10px;font-size:13px;margin-top:8px;color:#1f2a10}
  .note.w{background:#fff7e6;color:#713f12}
  .note.e{background:#fdeeee;color:#7f1d1d}
  .lnk{background:none;border:0;color:#15192e;font-size:13px;font-weight:700;padding:4px 0;min-height:32px}
  .ft{margin-top:8px;padding-top:6px;border-top:1px solid #f1f5f9}
  .spin{width:16px;height:16px;flex:none;border-radius:50%;border:2px solid rgba(21,25,46,.18);border-top-color:#15192e;animation:s .8s linear infinite}
  .pill.good .spin{border-color:rgba(255,255,255,.3);border-top-color:#c5f04a}
  @keyframes s{to{transform:rotate(360deg)}}
  .ab{position:fixed;left:10px;top:calc(env(safe-area-inset-top,0px) + 60px);z-index:2147483003;width:min(380px,calc(100vw - 20px));background:#0f172a;color:#fff;border-radius:16px;
    padding:12px 14px;box-shadow:0 10px 30px rgba(2,6,23,.35);font-size:14px}
  .ab .st{font-size:12px;color:#c5f04a;font-weight:700}
  .ab .acts{display:flex;gap:8px;margin-top:10px}
  .ab .nb{background:#334155;color:#fff}
  .ab .go{background:#c5f04a;color:#15192e;flex:1}
  .ring{position:fixed;z-index:2147483000;width:64px;height:64px;margin:-32px 0 0 -32px;border-radius:50%;border:3px solid #c5f04a;pointer-events:none;animation:p 1.2s ease-out infinite}
  @keyframes p{0%{transform:scale(.5);opacity:1}100%{transform:scale(1.4);opacity:0}}
  .toast{position:fixed;top:calc(env(safe-area-inset-top,0px) + 16px);left:50%;transform:translateX(-50%);z-index:2147483004;background:#0f172a;color:#fff;border-radius:12px;padding:10px 16px;font-size:13px;max-width:90vw}
  .dn{color:#c5f04a;font-weight:700}.up{color:#fca5a5;font-weight:700}
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
    root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'cap') { e.preventDefault(); startRun(); } });
    render();
  }
  const emit = () => { try { render(); } catch (e) { console.error('[yeghadam]', e); } };

  // Top edge of Snapp's bottom sheet: the outermost full-width box under the bottom of the screen that starts below
  // the top fifth of it. Falls back to half the screen.
  function sheetTop() {
    const w = window.innerWidth, h = window.innerHeight;
    let top = 0;
    for (let el = document.elementFromPoint(w / 2, h - 4); el && el !== document.body; el = el.parentElement) {
      if (el === host) return h / 2;
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
    const html = `<style>${CSS}</style><div class="w">${state.sheet && !state.apply && !state.probe ? panelHTML() : pillHTML()}${probeHTML()}${applyHTML()}${state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ''}</div>`;
    if (html === lastHTML) return;
    const sc = root.querySelector('.bd'), top = sc ? sc.scrollTop : 0;
    const act = root.activeElement, focusId = act && act.id, caret = act && act.selectionStart;
    root.innerHTML = html;
    lastHTML = html;
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
      return { cls: 'good', spin: true, text: `بررسی ${total ? fa(done) + ' از ' + fa(total) : '…'}` };
    }
    if (state.error) return { cls: 'bad', text: 'یه‌قدم: خطا' };
    if (state.applied) return { cls: 'good', text: 'اعمال شد' };
    if (resultFresh()) {
      const top = currentCards();
      if (top.length) {
        const best = top.reduce((a, b) => (b.saving > a.saving ? b : a));
        return { cls: 'good', text: `تا ${toman(best.saving)} ارزون‌تر، با ${fa(best.c.walk)} متر پیاده` };
      }
      return { cls: '', text: 'همین‌جا بهترینه' };
    }
    if (onPricePage()) return { cls: '', text: 'ارزون‌ترش کن' };
    return null;
  }
  function pillHTML() {
    if (state.apply || state.probe || !authHeader()) return '';
    const s = status();
    if (!s) return '';
    return `<button class="pill ${s.cls}" data-a="open">${s.spin ? '<span class="spin"></span>' : LOGO}${esc(s.text)}</button>`;
  }

  function serviceSwitch(prices, names) {
    const ids = Object.keys(prices || {}).map(Number);
    if (ids.length < 2) return '';
    return `<div class="seg sm">${ids.map((id) => `<button class="${sid() === id ? 'on' : ''}" data-a="svc" data-k="${id}">${esc(names[id] || id)}</button>`).join('')}</div>`;
  }

  function setupHTML() {
    const offered = bikeOffered() ? (state.snapp.categories || []).filter((c) => c.id === CAR || c.id === BIKE) : [];
    const cats = offered.length > 1 ? `<div class="seg sm" style="margin-bottom:8px">${offered.map((c) => `<button class="${cat() === c.id ? 'on' : ''}" data-a="cat" data-k="${c.id}">${esc(c.name)}</button>`).join('')}</div>` : '';
    const sw = cat() === CAR && state.snapp ? serviceSwitch(state.snapp.prices, state.snapp.names) : '';
    const svc = sw ? `<div style="margin-bottom:8px">${sw}</div>` : '';
    return `${cats}${svc}<div class="q">امروز تا کجا حاضری پیاده بری؟</div>
      <div class="seg">${BUDGETS.map((b) => `<button class="${settings.budget === b ? 'on' : ''}" data-a="budget" data-k="${b}">${fa(b)} متر</button>`).join('')}</div>
      <div class="cap"><input id="cap" inputmode="numeric" autocomplete="off" placeholder="تا چند حاضری بدی؟ (اختیاری، مثلاً ۱۶۰)" value="${esc(state.capText)}"><span class="muted">هزار تومان</span></div>
      <button class="btn" data-a="run" ${state.route ? '' : 'disabled'}>پیدا کن</button>
      <div class="muted" style="margin-top:6px">حدود ${fa(23)} استعلام در ۱۰ ثانیه. فقط قیمت می‌پرسه؛ سفری ثبت نمی‌شه.</div>`;
  }

  const KIND = { origin: 'مبدا', dest: 'مقصد', both: 'هر دو' };
  function placeShort(c) {
    if (c.kind === 'both') return `${placeText(c.origin)} / ${placeText(c.dest)}`;
    return placeText(c) + (c.twin ? ' (قیمت تازه)' : '');
  }
  function cardHTML(k, i) {
    const c = k.c, sel = c === state.selected ? ' sel' : '';
    return `<div class="card${sel}" data-a="pick" data-k="${esc(c.id)}">
      <div class="r1"><span class="n">${fa(i + 1)}</span><span class="sv">${toman(k.saving)} ارزون‌تر</span>
        <button class="go" data-a="apply" data-k="${esc(c.id)}">اعمال</button><button class="x" data-a="dismiss" data-k="${esc(c.id)}" title="اینجا نمی‌رم" aria-label="اینجا نمی‌رم">${ICON.close}</button></div>
      <div class="r2"><span class="k ${c.kind}">${KIND[c.kind]}</span>${esc(placeShort(c))}، <b>${fa(c.walk)} متر</b> پیاده، ${toman(k.price)}</div>
    </div>`;
  }

  function resultHTML() {
    const r = state.result, s = sid();
    let h = '';
    const bp = C.priceOf(r.base, s);
    h += `<div class="now">${serviceSwitch(r.base.prices, r.names) || '<span class="muted" style="flex:1">قیمت الان</span>'}<b>${toman(bp)}</b></div>`;
    if (r.drift && Math.abs(r.drift) >= C.MIN_SAVING) {
      h += `<div class="note w">قیمت اسنپ وسط جستجو ${r.drift > 0 ? 'گرون' : 'ارزون'} شد (${toman(Math.abs(r.drift))}). <button class="lnk" data-a="run">دوباره بگرد</button></div>`;
    }
    if (r.baseLock && r.twin) {
      const left = Math.round(r.baseLock.left - (Date.now() - r.baseLock.at) / 1000);
      const now = C.priceOf(r.twin, s);
      if (left > 0 && now - bp >= C.MIN_SAVING) {
        h += `<div class="note">قیمتت قفل شده و از قیمت لحظه‌ای (${toman(now)}) ارزون‌تره. تا ${fa(Math.ceil(left / 60))} دقیقهٔ دیگه همینه؛ جابجا کردن پین قیمت تازه می‌گیره.</div>`;
      } else if (bp - now >= C.MIN_SAVING) {
        h += `<div class="note">قیمت لحظه‌ای از قیمت قفل‌شده‌ات ارزون‌تر شده؛ یه جابجایی کوتاه پین قیمت تازه می‌گیره.</div>`;
      }
    }
    if (r.approx.origin || r.approx.dest) h += `<div class="note w">نقشهٔ خیابان‌ها این‌جا نیومد؛ فاصله‌ها خط هوایی‌ان. قبل از اعمال روی نقشه ببین.</div>`;
    h += capHTML(r, s, bp);
    const cs = C.cards(r, s);
    if (cs.length) h += cs.map(cardHTML).join('');
    else if (!state.running) {
      const n = r.origins.length + r.dests.length;
      h += `<div class="note"><b>همین‌جا بهترینه.</b> ${fa(n)} نقطه تا ${fa(r.budget)} متر بررسی شد؛ هیچ‌کدوم دست‌کم ۱٬۰۰۰ تومان ارزون‌تر نبود.</div>`;
    }
    return h;
  }

  // The price limit does not cut the search short; it answers one question about the full result:
  // what is the shortest walk that gets the price under your limit?
  function capHTML(r, s, bp) {
    const cap = parseToman(state.capText) * 10;
    if (!cap || state.running) return '';
    if (bp <= cap) return `<div class="note">همین الان زیر ${toman(cap)} هستی؛ لازم نیست جابجا شی.</div>`;
    const list = r.origins.concat(r.dests, r.combo ? [r.combo] : []).filter((c) => !c.dismissed && C.priceOf(c, s) <= cap);
    if (!list.length) {
      const near = C.nearestToCap(r, s);
      return `<div class="note w">تا ${fa(r.budget)} متر هیچ نقطه‌ای زیر ${toman(cap)} نبود${near ? `؛ ارزون‌ترین ${toman(C.priceOf(near, s))} با ${fa(near.walk)} متر` : ''}.</div>`;
    }
    const best = list.sort((a, b) => a.walk - b.walk || C.priceOf(a, s) - C.priceOf(b, s))[0];
    return `<div class="note">کمترین پیاده‌روی برای زیر ${toman(cap)}: <b>${fa(best.walk)} متر</b> (${toman(C.priceOf(best, s))}). <button class="lnk" data-a="pick" data-k="${esc(best.id)}">نشونم بده</button></div>`;
  }

  function panelHTML() {
    const r = state.result, st = status();
    let h = `<div class="pn"><div class="hd">${LOGO}<b>یه‌قدم</b><span class="sp"></span>
      ${st && st.spin ? '<span class="spin"></span>' : ''}<button class="ic" data-a="close" title="جمع کن" aria-label="جمع کن">${ICON.collapse}</button></div>`;
    if (state.running) {
      const done = r ? r.requests : 0, total = r && r.planned ? r.planned : 23;
      h += `<div class="bar"><i style="transform:scaleX(${(done / Math.max(1, total)).toFixed(3)})"></i></div>`;
    }
    h += '<div class="bd">';
    if (!authHeader()) h += `<div class="note w">اول وارد اکانت اسنپ شو.</div>`;
    else if (!state.route) h += `<div class="note w">مبدا و مقصد رو توی اسنپ انتخاب و تأیید کن تا قیمت بیاد.</div>`;
    if (state.running) {
      const done = r ? r.requests : 0, total = r && r.planned ? r.planned : 23;
      h += `<div class="muted">در حال بررسی ${fa(done)} از ${fa(total)} نقطه، تا ${fa(settings.budget)} متر پیاده…</div>`;
      if (r && r.base) h += resultHTML();
      h += `<button class="btn ghost" data-a="stop">توقف</button>`;
    } else if (state.error) {
      h += `<div class="note e">${errText(state.error)}</div>`;
      if (r && r.base) h += resultHTML();
      h += setupHTML();
    } else if (r && r.base && !state.setup) {
      h += resultHTML();
      h += `<div class="ft"><button class="lnk" data-a="setup">جستجوی دوباره</button>
        <div class="muted">برای قیمت یک نقطهٔ دلخواه، روی نقشه انگشتت رو نگه دار.</div></div>`;
    } else if (state.route) {
      h += setupHTML();
    }
    if (!(r && r.base && !state.setup && !state.running)) h += `<div class="muted ft">برنامهٔ غیررسمی؛ ربطی به اسنپ نداره.</div>`;
    h += '</div></div>';
    return h;
  }

  function probeHTML() {
    const p = state.probe;
    if (!p || state.apply) return '';
    const s = sid(), lbl = LABEL[p.kind];
    let body;
    if (p.loading) body = `<div><span class="spin" style="display:inline-block;vertical-align:middle"></span> قیمت این نقطه به‌عنوان ${lbl}…</div>`;
    else if (p.error) body = `<div>${errText(p.error)}</div>`;
    else {
      const price = C.priceOf(p, s), ref = p.base ? p.base[s] : NaN, d = price - ref;
      const delta = isFinite(d) && d ? ` <span class="${d < 0 ? 'dn' : 'up'}" style="color:${d < 0 ? '#c5f04a' : '#fca5a5'}">${d < 0 ? fa(Math.round(-d / 10)) + ' ارزان‌تر' : fa(Math.round(d / 10)) + ' گران‌تر'}</span>` : '';
      body = `<div>این‌جا به‌عنوان ${lbl}: <b>${toman(price)}</b>${delta}</div><div class="muted" style="color:#cbd5e1">حدود ${fa(p.walk)} متر ${p.dir} (خط هوایی)</div>`;
    }
    const canApply = !p.loading && !p.error && p.prices;
    return `<div class="ab"><div class="st">قیمت یک نقطه</div>${body}
      <div class="acts">${canApply ? `<button class="go" data-a="applyProbe">اعمال در اسنپ</button>` : ''}<button class="nb" data-a="closeProbe">بستن</button></div></div>`;
  }

  function applyHTML() {
    const a = state.apply;
    if (!a) return '';
    const s = a.steps[a.i], lbl = LABEL[s.kind];
    const stepTxt = a.steps.length > 1 ? `مرحله ${fa(a.i + 1)} از ${fa(a.steps.length)}` : 'اعمال';
    let msg = '', acts = '';
    if (a.phase === 'fly') msg = `در حال بردن پین ${lbl} به نقطهٔ ارزان‌تر…`;
    else if (a.phase === 'confirm') msg = `روی <b>پین اسنپ</b> (وسط دایرهٔ چشمک‌زن) بزن تا ${lbl} جدید تأیید شود.`;
    else {
      msg = `برچسب «${lbl}» روی نقشه پیدا نشد. خودت روی «${lbl}» روی نقشه بزن، بعد «ادامه» رو بزن.`;
      acts = `<button class="go" data-a="manualGo">ادامه</button>`;
    }
    return `<div class="ab"><div class="st">${stepTxt}، ${esc(lbl + ': ' + placeText(s.c))}</div><div>${msg}</div>
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
    if (a === 'open') { state.sheet = true; emit(); }
    else if (a === 'close') { state.sheet = false; emit(); }
    else if (a === 'stop') state.cancel = true;
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
      if (window.innerWidth < 640) state.sheet = false; // on a phone the panel covers the map: show the point instead
      drawMap(); emit(); moveMapTo(c.kind === 'both' ? c.dest : c);
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
    if (state.apply) { cancelApply(); return true; }
    if (state.probe) { state.probe = null; emit(); drawMap(); return true; }
    if (state.sheet) { state.sheet = false; emit(); return true; }
    return false;
  };

  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  setInterval(() => {
    if (!host) mount();
    else if (!document.contains(host) && document.body) document.body.appendChild(host);
    syncRoute(); // markers settle after Snapp's request returns
    layout();
    emit();
  }, 1500);

  window.__yeghadamDebug = { state, settings: () => settings, run, findSnappLabel, core: C, allQuoted };
})();
