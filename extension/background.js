// Routes a price question from one service's tab to the tab of the other service, and opens or focuses that tab.
// It only moves route points and a price; it makes no network request of its own.
const api = typeof browser !== 'undefined' ? browser : chrome;
const SNAPP = 'https://app.snapp.taxi/';
const TAPSI = 'https://app.tapsi.cab/';

const isTapsi = (sender) => !!sender.url && sender.url.startsWith(TAPSI);
const otherPattern = (sender) => (isTapsi(sender) ? SNAPP : TAPSI) + '*';

// 2 to 6 numeric lat/lng pairs, rebuilt from scratch.
function cleanPoints(points) {
  if (!Array.isArray(points) || points.length < 2 || points.length > 6) return null;
  const out = [];
  for (const p of points) {
    const lat = p && +p.lat, lng = p && +p.lng;
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    out.push({ lat, lng });
  }
  return out;
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
    return (await api.tabs.sendMessage(tab.id, { kind: 'ask', points: pts })) || { status: 'none' };
  } catch (e) {
    // The tab is open but nothing answered: it was loaded before the extension was (re)installed, or the browser
    // discarded it to save memory. Reloading that tab fixes both.
    console.warn('[yeghadam] the other tab did not answer:', e && e.message);
    return { status: 'closed', why: 'unreachable' };
  }
}

// A route waiting for a Snapp tab to finish loading: tab id -> { points, at }. Snapp has no route in its URL, so the
// page script asks for it once it is up and places it itself. It is handed over once and expires after two minutes.
const pending = new Map();
const PENDING_MS = 2 * 60 * 1000;

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
  if (toSnapp && target && target.id != null) pending.set(target.id, { points: pts, at: Date.now() });
}

function takePending(sender) {
  const p = pending.get(sender.tab.id);
  pending.delete(sender.tab.id);
  return p && Date.now() - p.at < PENDING_MS && !isTapsi(sender) ? p.points : null;
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender || !sender.tab || sender.id !== api.runtime.id) return undefined;
  if (msg.kind === 'quote') {
    ask(sender, msg.points).then(sendResponse, () => sendResponse({ status: 'none' }));
    return true;
  }
  if (msg.kind === 'pending') {
    sendResponse(takePending(sender));
    return undefined;
  }
  if (msg.kind === 'open') {
    openOther(sender, msg.points).then(() => sendResponse(true), () => sendResponse(false));
    return true;
  }
  return undefined;
});
