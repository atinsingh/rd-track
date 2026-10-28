/**
 * Bootstraps a vendor platform operator (commercial model §5). Prints a one-time
 * password and the TOTP secret to add to an authenticator app; MFA is mandatory.
 *
 *   pnpm --filter @rd/api platform:create-admin -- ops@rounddigital.example "Ops Name"
 */
import { loadConfig } from '../config';
import { createPool } from '../db/pool';
import { encryptSecret, newTotpSecret, randomToken } from '../lib/crypto';
import { createPlatformAdmin } from '../modules/platform/routes';

const [email, name] = process.argv.slice(2).filter((a) => a !== '--');
if (!email || !name) {
  console.error('usage: create-platform-admin <email> <display name>');
  process.exit(2);
}
const config = loadConfig();
const pool = createPool(config.databaseUrl);
const password = randomToken(18);
const secret = newTotpSecret();
await createPlatformAdmin(pool, email, name, password, encryptSecret(config.appEncryptionKey, secret));
await pool.end();
console.log(`Platform operator created: ${email}
  one-time password: ${password}
  TOTP secret:       ${secret}
  otpauth URL:       otpauth://totp/${encodeURIComponent(`RoundDigital Track Platform:${email}`)}?secret=${secret}&issuer=RoundDigital%20Track`);
