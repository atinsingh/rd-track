const api = globalThis.browser ?? globalThis.chrome;
const t = (/** @type {string} */ k) => api.i18n.getMessage(k);

for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(/** @type {HTMLElement} */ (el).dataset.i18n ?? '');

const state = /** @type {HTMLElement} */ (document.getElementById('state'));
/** @type {{ link: string, collecting: boolean } | undefined} */
const s = await api.runtime.sendMessage({ type: 'status' }).catch(() => undefined);
state.textContent = !s || s.link === 'no_app' ? t('stateNoApp') : s.collecting ? t('stateSharing') : t('stateIdle');
state.dataset.on = String(Boolean(s?.collecting));
