// Relay between the page script (page world) and the extension's background script. The page world cannot call
// the extension API, and its two halves (Snapp tab, Tapsi tab) cannot reach each other directly, so questions and
// answers travel: page, this relay, background, the other tab's relay, the other page.
(() => {
  'use strict';
  const api = typeof browser !== 'undefined' ? browser : chrome;
  const pendingAsks = {}; // id of a question from the other tab -> reply callback
  let askSeq = 0;

  // After the extension is reloaded or updated, the copy of this script left in an open tab loses its connection and
  // sendMessage throws at once (not as a rejected promise). Turn that into a rejection so the page just gets "none".
  const send = (message) => {
    try { return Promise.resolve(api.runtime.sendMessage(message)); } catch (e) { return Promise.reject(e); }
  };
  const toPage = (message) => window.postMessage(Object.assign({ yeghadamRelay: true }, message), location.origin);

  // The page asks for the other service's price, or asks to open the other service.
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || typeof d.yeghadam !== 'string') return;
    if (d.yeghadam === 'peer-quote') {
      send({ kind: 'quote', points: d.points })
        .then((answer) => toPage({ type: 'answer', id: d.id, answer: answer || { status: 'none' } }))
        .catch(() => toPage({ type: 'answer', id: d.id, answer: { status: 'none' } }));
    } else if (d.yeghadam === 'peer-open') {
      send({ kind: 'open', points: d.points }).catch(() => {});
    } else if (d.yeghadam === 'route-pending') {
      send({ kind: 'pending' })
        .then((points) => { if (points) toPage({ type: 'route', points }); })
        .catch(() => {});
    } else if (d.yeghadam === 'peer-answer') {
      const reply = pendingAsks[d.id];
      if (reply) reply(d.answer);
    }
  });

  // The other tab asks this page for its price.
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.kind !== 'ask') return undefined;
    const id = ++askSeq;
    const timer = setTimeout(() => finish({ status: 'none' }), 40000);
    const finish = (answer) => { clearTimeout(timer); delete pendingAsks[id]; sendResponse(answer); };
    pendingAsks[id] = finish;
    toPage({ type: 'ask', id, points: msg.points });
    return true;
  });
})();
