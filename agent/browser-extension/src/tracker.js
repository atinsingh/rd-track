import { domainOf } from './domain.js';

/** The desktop app's native messaging host. */
export const HOST = 'digital.round.track';
/** How often the extension checks in (the app treats a report as current for 90 s). */
export const HEARTBEAT_MINUTES = 0.5;

/**
 * Tells the RoundDigital Track desktop app which site the active tab is on, and only
 * when the app asks for it: the app answers every message with `{collect}`, which is
 * true only while a work session runs under a policy that records website domains.
 * Until then the extension sends no domain at all, just that it is there.
 *
 * Private windows are never looked at, and a window that is not in front counts as no
 * site.
 *
 * @param {object} api `chrome` or `browser`
 * @param {{ instance: () => Promise<string> }} opts
 */
export function createTracker(api, opts) {
  /** @type {any} */
  let port = null;
  let collect = false;
  /** @type {'connecting' | 'connected' | 'no_app'} */
  let link = 'connecting';
  let lastSent = /** @type {string | null | undefined} */ (undefined);
  const instance = opts.instance();

  function connect() {
    if (port) return port;
    try {
      port = api.runtime.connectNative(HOST);
    } catch {
      port = null;
      link = 'no_app';
      return null;
    }
    link = 'connecting';
    port.onMessage.addListener((/** @type {any} */ m) => {
      link = 'connected';
      const was = collect;
      collect = m?.collect === true;
      // Just asked to start: say where the person is now.
      if (collect && !was) void report();
      if (!collect) lastSent = null;
    });
    port.onDisconnect.addListener(() => {
      port = null;
      collect = false;
      link = 'no_app';
    });
    return port;
  }

  /** The site in front, or null (no focused normal window, a private window, a browser page). */
  async function activeDomain() {
    let win;
    try {
      win = await api.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
    } catch {
      return null;
    }
    if (!win || !win.focused || win.incognito) return null;
    const tab = (win.tabs ?? []).find((/** @type {any} */ t) => t.active);
    if (!tab || tab.incognito) return null;
    return domainOf(tab.url);
  }

  /** Sends what the app may know now. `heartbeat` repeats an unchanged report. */
  async function report(heartbeat = false) {
    const p = connect();
    if (!p) return;
    const domain = collect ? await activeDomain() : null;
    if (!heartbeat && domain === lastSent) return;
    lastSent = domain;
    try {
      p.postMessage({ instance: await instance, domain });
    } catch {
      port = null;
      link = 'no_app';
    }
  }

  function start() {
    api.tabs.onActivated.addListener(() => void report());
    api.tabs.onUpdated.addListener((/** @type {number} */ _id, /** @type {any} */ change, /** @type {any} */ tab) => {
      if (tab?.active && change.url !== undefined) void report();
    });
    api.windows.onFocusChanged.addListener(() => void report());
    api.alarms.create('heartbeat', { periodInMinutes: HEARTBEAT_MINUTES });
    api.alarms.onAlarm.addListener((/** @type {any} */ a) => {
      if (a.name === 'heartbeat') void report(true);
    });
    api.runtime.onMessage.addListener((/** @type {any} */ m, /** @type {any} */ _sender, /** @type {(r: unknown) => void} */ reply) => {
      if (m?.type === 'status') reply(status());
    });
    void report(true);
  }

  function status() {
    return { link, collecting: collect };
  }

  return { start, report, status };
}
