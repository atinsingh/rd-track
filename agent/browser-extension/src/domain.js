/**
 * The only thing the extension ever takes from a tab: its hostname, lowercased and
 * without "www.". Anything that is not an ordinary web page (browser pages, files,
 * extension pages, data: URLs) gives nothing.
 * @param {string | undefined} url
 * @returns {string | null}
 */
export function domainOf(url) {
  if (!url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  let host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) return null; // IPv6 literal: not a site name
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.includes('..')) return null;
  return host;
}
