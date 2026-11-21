// Tests for extension/background.js, which passes route points and prices between the Snapp tab and the Tapsi tab.
// It is loaded into a sandbox with a fake extension API. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
const SNAPP_TAB = { id: 1, url: 'https://app.snapp.taxi/pre-ride' };
const TAPSI_TAB = { id: 2, url: 'https://app.tapsi.cab/preview?origin=[51.4,35.7]' };
const ROUTE = [{ lat: 35.7, lng: 51.4 }, { lat: 35.71, lng: 51.41 }];
// values made in the sandbox have its own Array and Object prototypes; compare them as plain data
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// tabs: [{ id, url, answer(msg) }]; answer may throw to act like a tab whose content script is gone.
// session: a Map standing in for storage.session; pass the same one to a second load to act like a restarted worker.
function load(tabs, session) {
  const area = session || new Map();
  const log = { sent: [], created: [], updated: [] };
  const clock = { now: 1_800_000_000_000 };
  let listener = null;
  const chrome = {
    runtime: { id: 'yeghadam', onMessage: { addListener: (f) => { listener = f; } } },
    tabs: {
      query: async ({ url }) => tabs.filter((t) => t.url.startsWith(url.replace(/\*$/, ''))),
      sendMessage: async (id, msg) => {
        log.sent.push({ id, msg: plain(msg) });
        const t = tabs.find((x) => x.id === id);
        return t && t.answer ? t.answer(msg) : undefined;
      },
      create: async ({ url }) => {
        log.created.push(url);
        const tab = { id: 100 + log.created.length, url };
        tabs.push(tab);
        return tab;
      },
      update: async (id, props) => { log.updated.push({ id, props: plain(props) }); return Object.assign({ id }, props); },
    },
    windows: { update: async () => {} },
    storage: {
      session: {
        set: async (items) => { for (const k of Object.keys(items)) area.set(k, plain(items[k])); },
        get: async (k) => (area.has(k) ? { [k]: area.get(k) } : {}),
        remove: async (k) => { area.delete(k); },
      },
    },
  };
  vm.runInNewContext(SOURCE, { chrome, console: { warn() {} }, URLSearchParams, Date: { now: () => clock.now } });
  // Deliver a message the way the relay does and resolve with the reply (undefined when there is none).
  const send = (msg, tab, extensionId) => new Promise((resolve) => {
    const sender = { id: extensionId || 'yeghadam', tab: tab ? { id: tab.id } : undefined, url: tab && tab.url };
    if (listener(msg, sender, (reply) => resolve(plain(reply))) !== true) setImmediate(() => resolve(undefined));
  });
  return { log, clock, send, area };
}

test('quote: malformed points never reach the other tab', async () => {
  const bg = load([SNAPP_TAB, Object.assign({ answer: () => ({ status: 'ok', price: 1 }) }, TAPSI_TAB)]);
  const bad = [
    null,
    [ROUTE[0]],
    Array(7).fill(ROUTE[0]),
    [null, null],
    [{ lat: '', lng: '' }, ROUTE[1]],
    [{ lat: true, lng: true }, ROUTE[1]],
    [{ lat: 91, lng: 51 }, ROUTE[1]],
    [{ lat: 'x', lng: 51 }, ROUTE[1]],
  ];
  for (const points of bad) assert.deepEqual(await bg.send({ kind: 'quote', points }, SNAPP_TAB), { status: 'none' });
  assert.equal(bg.log.sent.length, 0);
});

test('quote: the points are rebuilt and the answer keeps only a known status and a price', async () => {
  const answers = [
    [{ status: 'ok', price: '2600000', html: '<img src=x onerror=alert(1)>', why: 'x' }, { status: 'ok', price: 2600000 }],
    [{ status: 'ok', price: -5 }, { status: 'none' }],
    [{ status: 'ok', price: '<b>1</b>' }, { status: 'none' }],
    [{ status: '<script>', price: 10 }, { status: 'none' }],
    [{ status: 'auth', price: 10 }, { status: 'auth' }],
    [undefined, { status: 'none' }],
  ];
  for (const [answer, expected] of answers) {
    const bg = load([SNAPP_TAB, Object.assign({ answer: () => answer }, TAPSI_TAB)]);
    const points = ROUTE.map((p) => Object.assign({ extra: 'dropped' }, p, { lat: String(p.lat) }));
    assert.deepEqual(await bg.send({ kind: 'quote', points }, SNAPP_TAB), expected);
    assert.deepEqual(bg.log.sent, [{ id: TAPSI_TAB.id, msg: { kind: 'ask', points: ROUTE } }]);
  }
});

test('quote: no tab of the other service, or one that does not answer, reads as closed', async () => {
  assert.deepEqual(await load([SNAPP_TAB]).send({ kind: 'quote', points: ROUTE }, SNAPP_TAB), { status: 'closed' });
  const gone = Object.assign({ answer: () => { throw new Error('Receiving end does not exist.'); } }, TAPSI_TAB);
  assert.deepEqual(await load([SNAPP_TAB, gone]).send({ kind: 'quote', points: ROUTE }, SNAPP_TAB), { status: 'closed', why: 'unreachable' });
});

test('messages from another extension or from outside a tab are ignored', async () => {
  const bg = load([SNAPP_TAB, Object.assign({ answer: () => ({ status: 'ok', price: 1 }) }, TAPSI_TAB)]);
  assert.equal(await bg.send({ kind: 'quote', points: ROUTE }, SNAPP_TAB, 'someone-else'), undefined);
  assert.equal(await bg.send({ kind: 'open', points: ROUTE }, null), undefined);
  assert.equal(bg.log.sent.length + bg.log.created.length, 0);
});

test('open from Snapp: Tapsi gets the route in its URL', async () => {
  const bg = load([SNAPP_TAB]);
  const route = ROUTE.concat([{ lat: 35.72, lng: 51.42 }]);
  assert.equal(await bg.send({ kind: 'open', points: route }, SNAPP_TAB), true);
  assert.equal(bg.log.created.length, 1);
  const url = new URL(bg.log.created[0]);
  assert.equal(url.origin + url.pathname, 'https://app.tapsi.cab/preview');
  assert.deepEqual(JSON.parse(url.searchParams.get('origin')), [51.4, 35.7]);
  assert.deepEqual(JSON.parse(url.searchParams.get('destinations')), [[51.41, 35.71], [51.42, 35.72]]);
});

test('open from Tapsi: the route waits for the new Snapp tab, once, for two minutes', async () => {
  const bg = load([TAPSI_TAB]);
  await bg.send({ kind: 'open', points: ROUTE }, TAPSI_TAB);
  assert.deepEqual(bg.log.created, ['https://app.snapp.taxi/pre-ride']);
  const snapp = { id: 101, url: 'https://app.snapp.taxi/pre-ride' };
  assert.equal(await bg.send({ kind: 'pending' }, { id: 101, url: TAPSI_TAB.url }), null, 'never handed to a Tapsi page');

  await bg.send({ kind: 'open', points: ROUTE }, TAPSI_TAB);
  assert.deepEqual(await bg.send({ kind: 'pending' }, snapp), ROUTE);
  assert.equal(await bg.send({ kind: 'pending' }, snapp), null, 'handed over only once');

  await bg.send({ kind: 'open', points: ROUTE }, TAPSI_TAB);
  bg.clock.now += 2 * 60 * 1000;
  assert.equal(await bg.send({ kind: 'pending' }, snapp), null, 'expired');
});

test('open from Tapsi: the route survives the background script being stopped while Snapp loads', async () => {
  const tabs = [TAPSI_TAB];
  const first = load(tabs);
  await first.send({ kind: 'open', points: ROUTE }, TAPSI_TAB);
  const restarted = load(tabs, first.area); // a new worker: empty memory, same session storage
  assert.deepEqual(await restarted.send({ kind: 'pending' }, { id: 101, url: 'https://app.snapp.taxi/pre-ride' }), ROUTE);
  assert.equal(first.area.size, 0, 'handed over once and removed');
});
