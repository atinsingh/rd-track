// Drives a real Chromium with the Track extension for scripts/e2e-browser.sh: opens a page
// on docs.example (mapped to this machine), and a second one in a private window that must
// never be reported. Keeps the browser open for the given number of seconds.
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const [profile, extension, seconds] = process.argv.slice(2);

const server = http.createServer((_q, r) => r.end('<!doctype html><title>Docs</title><p>Work.</p>')).listen(0);
const port = server.address().port;
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--host-resolver-rules=MAP docs.example 127.0.0.1, MAP secret.example 127.0.0.1'],
});
const page = await ctx.newPage();
await page.goto(`http://docs.example:${port}/handbook/payroll?token=abc`);
console.log('browser: on docs.example');
await new Promise((r) => setTimeout(r, Number(seconds) * 1000));
await ctx.close();
server.close();
