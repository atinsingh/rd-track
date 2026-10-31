import { createTracker } from './tracker.js';

const api = globalThis.browser ?? globalThis.chrome;

/** A random name for this browser profile's copy of the extension, kept across restarts. */
async function instance() {
  const { instance } = await api.storage.local.get('instance');
  if (typeof instance === 'string' && /^[a-z0-9]{16,64}$/.test(instance)) return instance;
  const fresh = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  await api.storage.local.set({ instance: fresh });
  return fresh;
}

createTracker(api, { instance }).start();
