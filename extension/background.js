// Routes a price question from one service's tab to the tab of the other service, and opens or focuses that tab.
// It only moves route points and a price; it makes no network request of its own.
const api = typeof browser !== 'undefined' ? browser : chrome;
const SNAPP = 'https://app.snapp.taxi/';
const TAPSI = 'https://app.tapsi.cab/';

const isTapsi = (sender) => !!sender.url && sender.url.startsWith(TAPSI);
const otherPattern = (sender) => (isTapsi(sender) ? SNAPP : TAPSI) + '*';

// A coordinate given as a number or a numeric string. null, '' and true would otherwise pass as 0 or 1.
const coord = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? +v : NaN);

// 2 to 6 numeric lat/lng pairs, rebuilt from scratch.
function cleanPoints(points) {
  if (!Array.isArray(points) || points.length < 2 || points.length > 6) return null;
  const out = [];
  for (const p of points) {
    const lat = p ? coord(p.lat) : NaN, lng = p ? coord(p.lng) : NaN;
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    out.push({ lat, lng });
  }
  return out;
}

// The other page's answer, rebuilt: a known status, a positive price for "ok", and nothing else (as in the Android app).
function cleanAnswer(a) {
  const status = a && ['ok', 'auth', 'closed', 'none'].includes(a.status) ? a.status : 'none';
  if (status !== 'ok') return { status };
  const price = coord(a.price);
  return price > 0 && price < 1e10 ? { status, price } : { status: 'none' };
}

// Prefer the tab the rider used last when several are open.
async function otherTab(sender) {
  const tabs = await api.tabs.query({ url: otherPattern(sender) });
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return tabs[0] || null;
}

async function ask(sender, points) {
  const pts = cleanPoints(points);
  if (!pts) return { status: 'none' };
  const tab = await otherTab(sender);
  if (!tab) return { status: 'closed' };
  try {
    return cleanAnswer(await api.tabs.sendMessage(tab.id, { kind: 'ask', points: pts }));
  } catch (e) {
    // The tab is open but nothing answered: it was loaded before the extension was (re)installed, or the browser
    // discarded it to save memory. Reloading that tab fixes both.
    console.warn('[yeghadam] the other tab did not answer:', e && e.message);
    return { status: 'closed', why: 'unreachable' };
  }
}

// A route waiting for a Snapp tab to finish loading: tab id -> { points, at }. Snapp has no route in its URL, so the
// page script asks for it once it is up and places it itself. It is handed over once and expires after two minutes.
// The browser stops an idle background script after about 30 s, which a slow page load can outlast, so the route is also
// kept in storage.session (cleared when the browser closes, never written to disk); the Map is the fallback without it.
const pending = new Map();
const PENDING_MS = 2 * 60 * 1000;
const session = api.storage && api.storage.session;
const pendingKey = (tabId) => 'pending:' + tabId;

async function putPending(tabId, value) {
  pending.set(tabId, value);
  if (session) { try { await session.set({ [pendingKey(tabId)]: value }); } catch (e) { /* the Map still has it */ } }
}

// Bring a tab forward. Firefox for Android has a single window and a limited windows API, so focusing the window is
// best effort: the tab switch above is what matters.
async function focusTab(tab) {
  await api.tabs.update(tab.id, { active: true });
  try { await api.windows.update(tab.windowId, { focused: true }); } catch (e) { /* no windows API here */ }
}

// Open the other service with the route. Tapsi takes the route in its URL; Snapp's start page is driven by its script.
async function openOther(sender, points) {
  const pts = cleanPoints(points);
  const tab = await otherTab(sender);
  const toSnapp = isTapsi(sender);
  let url;
  if (toSnapp) url = SNAPP + 'pre-ride';
  else if (pts) {
    const q = new URLSearchParams();
    q.set('origin', JSON.stringify([pts[0].lng, pts[0].lat]));
    q.set('destinations', JSON.stringify(pts.slice(1).map((p) => [p.lng, p.lat])));
    url = TAPSI + 'preview?' + q.toString();
  } else url = TAPSI;
  if (!pts) { // no route to carry: just bring the other service forward
    if (tab) await focusTab(tab); else await api.tabs.create({ url });
    return;
  }
  const target = tab ? await api.tabs.update(tab.id, { url, active: true }) : await api.tabs.create({ url });
  if (tab) { try { await api.windows.update(tab.windowId, { focused: true }); } catch (e) { /* see focusTab */ } }
  if (toSnapp && target && target.id != null) await putPending(target.id, { points: pts, at: Date.now() });
}

async function takePending(sender) {
  const id = sender.tab.id;
  let p = pending.get(id);
  pending.delete(id);
  if (session) {
    try {
      const stored = await session.get(pendingKey(id));
      if (!p) p = stored[pendingKey(id)];
      await session.remove(pendingKey(id));
    } catch (e) { /* use what the Map had */ }
  }
  return p && Date.now() - p.at < PENDING_MS && !isTapsi(sender) ? p.points : null;
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender || !sender.tab || sender.id !== api.runtime.id) return undefined;
  if (msg.kind === 'quote') {
    ask(sender, msg.points).then(sendResponse, () => sendResponse({ status: 'none' }));
    return true;
  }
  if (msg.kind === 'pending') {
    takePending(sender).then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (msg.kind === 'open') {
    openOther(sender, msg.points).then(() => sendResponse(true), () => sendResponse(false));
    return true;
  }
  return undefined;
});
