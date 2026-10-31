import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * A small OpenID Connect provider for tests: discovery, JWKS, and a token endpoint that
 * answers codes handed out by `approve`. Tokens are RS256-signed with a real key.
 */
export class FakeIdp {
  issuer = '';
  clientId = 'track-client';
  clientSecret = 'track-secret';
  private server!: Server;
  private key: KeyObject;
  private publicJwk: Record<string, unknown>;
  private codes = new Map<string, Record<string, unknown>>();
  /** Signs with this key instead (an attacker's), keeping the published kid. */
  forgeWith: KeyObject | null = null;

  constructor(private readonly now: () => Date) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.key = privateKey;
    this.publicJwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'k1', use: 'sig', alg: 'RS256' };
  }

  async start() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', this.issuer);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/.well-known/openid-configuration') {
        return json(200, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        });
      }
      if (url.pathname === '/jwks') return json(200, { keys: [this.publicJwk] });
      if (url.pathname === '/token' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const form = new URLSearchParams(body);
          const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
          if (req.headers.authorization !== `Basic ${basic}`) return json(401, { error: 'invalid_client' });
          const claims = this.codes.get(form.get('code') ?? '');
          if (!claims || !form.get('code_verifier')) return json(400, { error: 'invalid_grant' });
          this.codes.delete(form.get('code')!);
          return json(200, { access_token: 'x', token_type: 'Bearer', id_token: this.idToken(claims) });
        });
        return;
      }
      json(404, {});
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  idToken(claims: Record<string, unknown>): string {
    const now = Math.floor(this.now().getTime() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: this.issuer, aud: this.clientId, iat: now, exp: now + 300, ...claims })).toString('base64url');
    const sig = sign('sha256', Buffer.from(`${header}.${payload}`), this.forgeWith ?? this.key).toString('base64url');
    return `${header}.${payload}.${sig}`;
  }

  /**
   * The person signs in at the provider: returns the callback query the browser would be
   * sent back with. `claims` override what goes in the ID token (nonce included).
   */
  approve(authorizeUrl: string, claims: Record<string, unknown>): { code: string; state: string; redirectUri: string } {
    const u = new URL(authorizeUrl);
    if (u.origin !== this.issuer) throw new Error(`not our authorize URL: ${authorizeUrl}`);
    const code = randomUUID();
    this.codes.set(code, { nonce: u.searchParams.get('nonce'), ...claims });
    return { code, state: u.searchParams.get('state')!, redirectUri: u.searchParams.get('redirect_uri')! };
  }
}
