import { API_TOKEN_MAX_DAYS, apiTokenRequest, type ApiTokenCreated, type ApiTokenDTO } from '@rd/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../context';
import { withTx } from '../db/pool';
import { userOf } from '../http';
import { parse } from '../lib/validate';
import { createToken, listTokens, revokeToken } from './api-tokens/service';
import { API_SURFACE } from './api-tokens/surface';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const code = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

/** The API reference: one page, generated from the same list that decides what tokens may call. */
function referenceHtml(base: string): string {
  const sections = [...new Set(API_SURFACE.map((e) => e.section))];
  const rows = (section: string) =>
    API_SURFACE.filter((e) => e.section === section)
      .map(
        (e) =>
          `<tr><td class="m m-${e.method.toLowerCase()}">${e.method}</td><td><code>${esc(e.path)}</code></td><td>${code(e.summary)}</td><td>${e.scopes.join(' + ')}${e.personal ? ' · <span class="p">personal</span>' : ''}</td></tr>`,
      )
      .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>RoundDigital Track API</title>
<style>
:root{color-scheme:light dark;--bg:#F6F7F9;--fg:#0E1013;--muted:#53595F;--line:#D9DCE0;--card:#fff;--code:#0B0C0F;--codefg:#E4E4E7}
@media (prefers-color-scheme:dark){:root{--bg:#0E1013;--fg:#ECEEF2;--muted:#A3A9B1;--line:#2A2E34;--card:#16181C}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 Inter,system-ui,sans-serif}
main{max-width:1040px;margin:0 auto;padding:40px 16px 64px}
h1{font-size:32px;letter-spacing:-.03em;margin:0 0 8px}h2{font-size:18px;margin:32px 0 10px}
p{max-width:760px;color:var(--muted)}code{font:12.5px 'JetBrains Mono',ui-monospace,monospace}
pre{background:var(--code);color:var(--codefg);padding:14px;overflow-x:auto;border-radius:10px;font:12.5px/1.6 'JetBrains Mono',ui-monospace,monospace}
.box{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:12px}
table{width:100%;min-width:640px;border-collapse:collapse}td,th{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font:500 11px 'JetBrains Mono',monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.m{font:600 12px 'JetBrains Mono',monospace;white-space:nowrap}.m-get{color:#1F6FB2}.m-post{color:#2E7D4F}.m-patch,.m-put{color:#8A5A00}.m-delete{color:#B42318}
.p{color:var(--muted)}dl{display:grid;grid-template-columns:160px minmax(0,1fr);gap:6px 14px}dt{color:var(--muted)}dd{margin:0}
</style></head><body><main>
<h1>RoundDigital Track API</h1>
<p>JSON over HTTPS. Create a token under Settings › Developers (organization tokens, org admins) or My account (personal tokens), and send it as a bearer token. A token sees what the person who created it could see — never more — and every call is in the audit log under the token's name.</p>
<pre>curl ${esc(base)}/v1/me \\
  -H "Authorization: Bearer $RD_TOKEN"</pre>
<h2>Tokens</h2>
<dl>
<dt>Organization</dt><dd><code>rdt_org_…</code> · org admins · <code>read</code>, optionally <code>write</code> and <code>payroll</code> · up to ${API_TOKEN_MAX_DAYS.organization} days</dd>
<dt>Personal</dt><dd><code>rdt_pat_…</code> · anyone · read-only, your own data (endpoints marked personal) · up to ${API_TOKEN_MAX_DAYS.personal} days</dd>
<dt>Never</dt><dd>Screenshot images, passwords and sign-in, tokens themselves, single sign-on, support access or closing the organization.</dd>
<dt>Errors</dt><dd><code>{"error": {"code", "message", "request_id"}}</code> · 401 <code>invalid_token</code> · 403 <code>insufficient_scope</code>, <code>not_in_api</code>, <code>forbidden</code> · 402/403 <code>plan_upgrade_required</code></dd>
<dt>Lists</dt><dd><code>{"items": [...]}</code>; the audit log pages with <code>cursor</code>. Times are ISO 8601 in UTC.</dd>
<dt>Machine-readable</dt><dd><a href="/v1/docs/openapi.json">/v1/docs/openapi.json</a> (OpenAPI 3.1)</dd>
</dl>
${sections.map((s) => `<h2>${esc(s)}</h2><div class="box"><table><thead><tr><th>Method</th><th>Path</th><th>What</th><th>Token needs</th></tr></thead><tbody>${rows(s)}</tbody></table></div>`).join('\n')}
</main></body></html>`;
}

function openApi(base: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of API_SURFACE) {
    const path = e.path.replace(/:([A-Za-z_]+)/g, '{$1}');
    const params = [...e.path.matchAll(/:([A-Za-z_]+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    paths[path] ??= {};
    paths[path][e.method.toLowerCase()] = {
      summary: e.summary.replace(/`/g, ''),
      tags: [e.section],
      ...(params.length ? { parameters: params } : {}),
      security: [{ bearer: e.scopes }],
      'x-rd-scopes': e.scopes,
      'x-rd-personal': e.personal,
      responses: { '200': { description: 'OK' }, '401': { description: 'invalid_token' }, '403': { description: 'insufficient_scope or not allowed' } },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'RoundDigital Track API', version: '1' },
    servers: [{ url: base }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'An API token (rdt_org_… or rdt_pat_…)' } } },
    paths,
  };
}

/** Settings › Developers (F5): API tokens and the API reference. */
export async function developerRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const user = { config: { auth: 'user' as const } };
  const pub = { config: { auth: 'public' as const } };

  app.get('/v1/api-tokens', user, async (req): Promise<{ items: ApiTokenDTO[] }> => ({ items: await listTokens(deps, pool, userOf(req)) }));
  app.post('/v1/api-tokens', user, async (req, reply) => {
    const a = userOf(req);
    const body = parse(apiTokenRequest, req.body);
    const created: ApiTokenCreated = await withTx(pool, (tx) => createToken(deps, tx, a, body, req.id));
    return reply.code(201).send(created);
  });
  app.post<{ Params: { id: string } }>('/v1/api-tokens/:id/revoke', user, async (req) => {
    const a = userOf(req);
    await withTx(pool, (tx) => revokeToken(deps, tx, a, parse(z.uuid(), req.params.id), req.id));
    return { ok: true };
  });

  app.get('/v1/docs', pub, async (_req, reply) =>
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
      .send(referenceHtml(deps.config.webUrl)),
  );
  app.get('/v1/docs/openapi.json', pub, async () => openApi(deps.config.webUrl));
}
