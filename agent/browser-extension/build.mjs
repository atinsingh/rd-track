// Builds the extension for each browser family into dist/<family>/ (no dependencies):
//   node build.mjs            → dist/chromium, dist/firefox
// Load dist/chromium unpacked (chrome://extensions, Developer mode) or dist/firefox as a
// temporary add-on (about:debugging). CI zips both for the stores and for IT deployment.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(readFileSync(join(here, f), 'utf8'));
const base = read('manifest.base.json');

for (const family of ['chromium', 'firefox']) {
  const out = join(here, 'dist', family);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(here, 'src'), out, { recursive: true });
  cpSync(join(here, '_locales'), join(out, '_locales'), { recursive: true });
  cpSync(join(here, 'icons'), join(out, 'icons'), { recursive: true });
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ ...base, ...read(`manifest.${family}.json`) }, null, 2) + '\n');
  console.log(`built ${out}`);
}
