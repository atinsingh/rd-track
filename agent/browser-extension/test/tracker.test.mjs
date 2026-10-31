import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTracker, HOST } from '../src/tracker.js';

/** A fake browser: one port to the app, windows to focus, events to fire. */
function fakeBrowser({ app = true } = {}) {
  const listeners = {};
  const on = (name) => ({ addListener: (f) => (listeners[name] = f) });
  const sent = [];
  let window = { focused: true, incognito: false, tabs: [{ active: true, url: 'https://github.com/x' }] };
  let reply = { collect: false };
  const port = {
    onMessage: on('port.message'),
    onDisconnect: on('port.disconnect'),
    postMessage(m) {
      sent.push(m);
      // The host answers every message.
      queueMicrotask(() => listeners['port.message'](reply));
    },
  };
  const api = {
    runtime: {
      connectNative(name) {
        assert.equal(name, HOST);
        if (!app) throw new Error('Specified native messaging host not found.');
        return port;
      },
      onMessage: on('runtime.message'),
    },
    windows: { getLastFocused: async () => window, onFocusChanged: on('focus') },
    tabs: { onActivated: on('activated'), onUpdated: on('updated') },
    alarms: { create: () => {}, onAlarm: on('alarm') },
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    api,
    sent,
    fire: async (name, ...args) => {
      listeners[name](...args);
      await settle();
      await settle();
    },
    setWindow: (w) => (window = w),
    setCollect: (c) => (reply = { collect: c }),
    settle,
  };
}

const opts = { instance: async () => 'p1' };

test('sends no domain until the app asks for one', async () => {
  const b = fakeBrowser();
  const t = createTracker(b.api, opts);
  t.start();
  await b.settle();
  await b.settle();
  assert.deepEqual(b.sent, [{ instance: 'p1', domain: null }]);
  // Switching tabs while not collecting sends nothing at all.
  await b.fire('activated', {});
  assert.equal(b.sent.length, 1);
  assert.deepEqual(t.status(), { link: 'connected', collecting: false });

  // A session starts collecting: the next check-in learns it and reports the site in front.
  b.setCollect(true);
  await b.fire('alarm', { name: 'heartbeat' });
  assert.deepEqual(b.sent.at(-1), { instance: 'p1', domain: 'github.com' });
  assert.equal(t.status().collecting, true);

  // A page change in the same tab is reported once; repeats are not.
  b.setWindow({ focused: true, tabs: [{ active: true, url: 'https://docs.rs/serde' }] });
  await b.fire('updated', 1, { url: 'https://docs.rs/serde' }, { active: true });
  await b.fire('updated', 1, { url: 'https://docs.rs/serde' }, { active: true });
  assert.deepEqual(b.sent.slice(-2).map((m) => m.domain), ['github.com', 'docs.rs']);

  // A background tab loading is not the site in front.
  const n = b.sent.length;
  await b.fire('updated', 2, { url: 'https://news.example' }, { active: false });
  assert.equal(b.sent.length, n);
});

test('private windows, unfocused windows and browser pages give no site', async () => {
  const b = fakeBrowser();
  b.setCollect(true);
  createTracker(b.api, opts).start();
  await b.settle();
  await b.settle();
  assert.equal(b.sent.at(-1).domain, 'github.com');
  for (const w of [
    { focused: true, incognito: true, tabs: [{ active: true, url: 'https://secret.example' }] },
    { focused: false, tabs: [{ active: true, url: 'https://github.com' }] },
    { focused: true, tabs: [{ active: true, url: 'chrome://history' }] },
  ]) {
    b.setWindow(w);
    await b.fire('focus', 1);
    assert.equal(b.sent.at(-1).domain, null, JSON.stringify(w));
    b.setWindow({ focused: true, tabs: [{ active: true, url: 'https://github.com/' }] });
    await b.fire('focus', 1);
  }
  assert.ok(!b.sent.some((m) => m.domain === 'secret.example'));
});

test('without the desktop app it says so and keeps nothing', async () => {
  const b = fakeBrowser({ app: false });
  const t = createTracker(b.api, opts);
  t.start();
  await b.settle();
  assert.deepEqual(t.status(), { link: 'no_app', collecting: false });
  assert.equal(b.sent.length, 0);
});
