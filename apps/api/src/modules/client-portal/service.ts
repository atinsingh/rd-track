import type {
  ClientContactDTO,
  ClientLinkInfo,
  ClientPortalInvoice,
  ClientPortalInvoiceSummary,
  ClientPortalMe,
  ClientPortalProject,
  ClientPortalReport,
} from '@rd/contracts';
import type { ClientActor, Deps, UserActor } from '../../context';
import { many, one, type Queryable } from '../../db/pool';
import { existsAnywhere } from '../../db/tenant-scope';
import type { EmailMessage } from '../../email/sender';
import { actionEmail } from '../../email/templates';
import { hashPassword, randomToken, sha256Hex, verifyPassword } from '../../lib/crypto';
import { AppError, errors } from '../../lib/errors';
import { projectReport } from '../activity/queries';
import { audit } from '../audit/service';
import { logoUrl } from '../branding/service';
import { listBudgets } from '../money/budgets';
import { getInvoice } from '../money/invoices';
import { hasMoneyPlan } from '../money/time';

/**
 * The client portal (Stage 4 F9): a read-only view for an agency's clients. Contacts are
 * not users — they have their own sign-in and sessions, hold no seat or role, and reach
 * only `/v1/client-portal/*`: their own projects' hours, budgets and issued invoices.
 * Names of the people who worked show only when the agency turns that on for the client,
 * and then each person shown gets an entry in their "Who viewed your data".
 */

export const CLIENT_SESSION_HOURS = 12;
const LINK_DAYS = 7;

const CONTACT_SELECT = `
  SELECT id, client_id, email, display_name, invited_at, last_sign_in_at, created_at,
         CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN password_hash IS NULL THEN 'invited' ELSE 'active' END AS status
  FROM client_contacts`;

export async function authenticateClient(deps: Pick<Deps, 'now'>, q: Queryable, token: string): Promise<ClientActor | 'not_entitled' | null> {
  const r = await one<{ contact_id: string; client_id: string; organization_id: string; display_name: string }>(
    q,
    `SELECT c.id AS contact_id, c.client_id, c.organization_id, c.display_name
     FROM client_sessions s JOIN client_contacts c ON c.id = s.contact_id JOIN clients cl ON cl.id = c.client_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND c.revoked_at IS NULL AND NOT cl.archived`,
    [sha256Hex(token), deps.now().toISOString()],
  );
  if (!r) return null;
  if (!(await hasMoneyPlan(deps, q, r.organization_id))) return 'not_entitled';
  return { kind: 'client', contactId: r.contact_id, clientId: r.client_id, organizationId: r.organization_id, displayName: r.display_name };
}

// ───────────── the agency's side ─────────────

async function assertClient(q: Queryable, orgId: string, clientId: string) {
  const c = await one<{ name: string; archived: boolean }>(q, 'SELECT name, archived FROM clients WHERE id = $1 AND organization_id = $2', [clientId, orgId]);
  if (!c) throw errors.notFound('Client');
  return c;
}

export async function listContacts(q: Queryable, orgId: string, clientId: string): Promise<ClientContactDTO[]> {
  await assertClient(q, orgId, clientId);
  return many<ClientContactDTO>(q, `${CONTACT_SELECT} WHERE organization_id = $1 AND client_id = $2 ORDER BY revoked_at NULLS FIRST, lower(display_name)`, [orgId, clientId]);
}

/** A fresh single-use sign-in link for the contact: the invite, or a new password. */
async function issueLink(deps: Deps, q: Queryable, contactId: string, orgId: string, actor: UserActor): Promise<EmailMessage> {
  const raw = randomToken();
  const now = deps.now();
  const c = await one<{ email: string; display_name: string; client_name: string; org_name: string; first: boolean }>(
    q,
    `UPDATE client_contacts SET link_token_hash = $3, link_expires_at = $4, invited_at = $5, invited_by = $6
     FROM clients cl, organizations o
     WHERE client_contacts.id = $1 AND client_contacts.organization_id = $2 AND cl.id = client_contacts.client_id AND o.id = client_contacts.organization_id
     RETURNING client_contacts.email, client_contacts.display_name, cl.name AS client_name, o.name AS org_name, client_contacts.password_hash IS NULL AS first`,
    [contactId, orgId, sha256Hex(raw), new Date(now.getTime() + LINK_DAYS * 86_400_000).toISOString(), now.toISOString(), actor.userId],
  );
  return actionEmail({
    to: c!.email,
    orgName: c!.org_name,
    title: c!.first ? `${c!.org_name} shared its work for ${c!.client_name} with you` : `Choose a new password for ${c!.org_name}'s client portal`,
    body: c!.first
      ? `${actor.displayName} at ${c!.org_name} gave you read-only access to the hours, budgets and invoices for ${c!.client_name}'s projects. Choose a password to sign in.`
      : `Use this link to choose a new password for the client portal.`,
    actionLabel: c!.first ? 'Choose a password' : 'Choose a new password',
    url: `${deps.config.webUrl}/client/link?token=${raw}`,
    expires: `in ${LINK_DAYS} days`,
    ignore: "If you weren't expecting it, you can ignore this email.",
  });
}

export async function inviteContact(
  deps: Deps,
  q: Queryable,
  actor: UserActor,
  clientId: string,
  input: { email: string; display_name: string },
  requestId?: string,
): Promise<{ contact: ClientContactDTO; email: EmailMessage }> {
  const client = await assertClient(q, actor.organizationId, clientId);
  if (client.archived) throw errors.conflict('client_archived', 'Unarchive this client first');
  if (await existsAnywhere(deps.pool, 'SELECT 1 FROM client_contacts WHERE lower(email) = lower($1) AND revoked_at IS NULL', [input.email]))
    throw errors.conflict('email_taken', 'This email already has a client portal sign-in');
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO client_contacts (organization_id, client_id, email, display_name) VALUES ($1, $2, $3, $4) RETURNING id`,
    [actor.organizationId, clientId, input.email.trim(), input.display_name],
  );
  const email = await issueLink(deps, q, r!.id, actor.organizationId, actor);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'client_contact.invite', targetType: 'client', targetId: clientId, requestId, metadata: { contact_id: r!.id } });
  const contact = (await one<ClientContactDTO>(q, `${CONTACT_SELECT} WHERE id = $1`, [r!.id]))!;
  return { contact, email };
}

async function liveContact(q: Queryable, orgId: string, id: string) {
  const c = await one<{ client_id: string; revoked: boolean }>(q, 'SELECT client_id, revoked_at IS NOT NULL AS revoked FROM client_contacts WHERE id = $1 AND organization_id = $2', [id, orgId]);
  if (!c) throw errors.notFound('Contact');
  if (c.revoked) throw errors.conflict('contact_revoked', 'This contact no longer has access');
  return c;
}

/** Sends a new sign-in link: a reminder for an invite, or a password reset. */
export async function resendLink(deps: Deps, q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<EmailMessage> {
  const c = await liveContact(q, actor.organizationId, id);
  const email = await issueLink(deps, q, id, actor.organizationId, actor);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'client_contact.link_sent', targetType: 'client', targetId: c.client_id, requestId, metadata: { contact_id: id } });
  return email;
}

export async function revokeContact(deps: Deps, q: Queryable, actor: UserActor, id: string, requestId?: string): Promise<ClientContactDTO> {
  const c = await liveContact(q, actor.organizationId, id);
  const now = deps.now().toISOString();
  await q.query('UPDATE client_contacts SET revoked_at = $2, link_token_hash = NULL WHERE id = $1', [id, now]);
  await q.query('UPDATE client_sessions SET revoked_at = $2 WHERE contact_id = $1 AND revoked_at IS NULL', [id, now]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'client_contact.revoke', targetType: 'client', targetId: c.client_id, requestId, metadata: { contact_id: id } });
  return (await one<ClientContactDTO>(q, `${CONTACT_SELECT} WHERE id = $1`, [id]))!;
}

export async function setPortalSettings(q: Queryable, actor: UserActor, clientId: string, showPeople: boolean, requestId?: string): Promise<{ show_people: boolean }> {
  await assertClient(q, actor.organizationId, clientId);
  await q.query('UPDATE clients SET portal_show_people = $2 WHERE id = $1', [clientId, showPeople]);
  await audit(q, { organizationId: actor.organizationId, actor, action: 'client.portal_settings', targetType: 'client', targetId: clientId, requestId, metadata: { show_people: showPeople } });
  return { show_people: showPeople };
}

// ───────────── signing in ─────────────

const badLink = () => new AppError(400, 'invalid_link', 'This link has expired or was already used. Ask for a new one.');

async function contactByLink(deps: Pick<Deps, 'now'>, q: Queryable, raw: string) {
  const c = await one<{ id: string; organization_id: string; client_id: string; email: string; display_name: string; client_name: string; org_name: string; first: boolean }>(
    q,
    `SELECT c.id, c.organization_id, c.client_id, c.email, c.display_name, cl.name AS client_name, o.name AS org_name, c.password_hash IS NULL AS first
     FROM client_contacts c JOIN clients cl ON cl.id = c.client_id JOIN organizations o ON o.id = c.organization_id
     WHERE c.link_token_hash = $1 AND c.link_expires_at > $2 AND c.revoked_at IS NULL`,
    [sha256Hex(raw), deps.now().toISOString()],
  );
  if (!c) throw badLink();
  return c;
}

export async function linkInfo(deps: Pick<Deps, 'now'>, q: Queryable, raw: string): Promise<ClientLinkInfo> {
  const c = await contactByLink(deps, q, raw);
  return { email: c.email, display_name: c.display_name, client_name: c.client_name, organization_name: c.org_name, first_time: c.first };
}

async function startSession(deps: Pick<Deps, 'now'>, q: Queryable, contactId: string, orgId: string): Promise<string> {
  const token = randomToken();
  const now = deps.now();
  await q.query('INSERT INTO client_sessions (organization_id, contact_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)', [
    orgId,
    contactId,
    sha256Hex(token),
    new Date(now.getTime() + CLIENT_SESSION_HOURS * 3600_000).toISOString(),
  ]);
  await q.query('UPDATE client_contacts SET last_sign_in_at = $2 WHERE id = $1', [contactId, now.toISOString()]);
  return token;
}

/** Sets the password from a link, ends any other sessions, and signs in. */
export async function acceptLink(deps: Deps, q: Queryable, raw: string, password: string, requestId?: string): Promise<string> {
  const c = await contactByLink(deps, q, raw);
  if (!(await hasMoneyPlan(deps, q, c.organization_id))) throw new AppError(403, 'portal_unavailable', 'The client portal is not available for this organization');
  await q.query('UPDATE client_contacts SET password_hash = $2, link_token_hash = NULL, link_expires_at = NULL WHERE id = $1', [c.id, await hashPassword(password)]);
  await q.query('UPDATE client_sessions SET revoked_at = $2 WHERE contact_id = $1 AND revoked_at IS NULL', [c.id, deps.now().toISOString()]);
  const actor: ClientActor = { kind: 'client', contactId: c.id, clientId: c.client_id, organizationId: c.organization_id, displayName: c.display_name };
  await audit(q, { organizationId: c.organization_id, actor, action: c.first ? 'client_contact.joined' : 'client_contact.password_reset', targetType: 'client', targetId: c.client_id, requestId });
  return startSession(deps, q, c.id, c.organization_id);
}

export async function login(deps: Deps, q: Queryable, email: string, password: string, requestId?: string): Promise<string> {
  const c = await one<{ id: string; organization_id: string; client_id: string; display_name: string; password_hash: string | null }>(
    q,
    `SELECT c.id, c.organization_id, c.client_id, c.display_name, c.password_hash
     FROM client_contacts c JOIN clients cl ON cl.id = c.client_id
     WHERE lower(c.email) = lower($1) AND c.revoked_at IS NULL AND NOT cl.archived`,
    [email],
  );
  const ok = await verifyPassword(password, c?.password_hash ?? null);
  if (!c || !ok) throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect');
  if (!(await hasMoneyPlan(deps, q, c.organization_id))) throw new AppError(403, 'portal_unavailable', 'The client portal is not available for this organization');
  const actor: ClientActor = { kind: 'client', contactId: c.id, clientId: c.client_id, organizationId: c.organization_id, displayName: c.display_name };
  await audit(q, { organizationId: c.organization_id, actor, action: 'client_contact.sign_in', targetType: 'client', targetId: c.client_id, requestId });
  return startSession(deps, q, c.id, c.organization_id);
}

export async function logout(q: Queryable, token: string, now: Date): Promise<void> {
  await q.query('UPDATE client_sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL', [sha256Hex(token), now.toISOString()]);
}

// ───────────── what the client sees ─────────────

export async function portalMe(deps: Pick<Deps, 'store'>, q: Queryable, actor: ClientActor): Promise<ClientPortalMe> {
  const r = await one<{ email: string; client_name: string; currency: string; show_people: boolean; org_name: string }>(
    q,
    `SELECT c.email, cl.name AS client_name, cl.currency, cl.portal_show_people AS show_people, o.name AS org_name
     FROM client_contacts c JOIN clients cl ON cl.id = c.client_id JOIN organizations o ON o.id = c.organization_id WHERE c.id = $1`,
    [actor.contactId],
  );
  return {
    contact: { id: actor.contactId, display_name: actor.displayName, email: r!.email },
    client: { id: actor.clientId, name: r!.client_name, currency: r!.currency, show_people: r!.show_people },
    organization: { name: r!.org_name, logo_url: await logoUrl(deps, q, actor.organizationId) },
  };
}

/** Hours on the client's projects in the range, with budgets; people's names only when the agency shows them. */
export async function portalReport(deps: Deps, q: Queryable, actor: ClientActor, r: { from: string; to: string }, tz: string, requestId?: string): Promise<ClientPortalReport> {
  const settings = await one<{ show_people: boolean }>(q, 'SELECT portal_show_people AS show_people FROM clients WHERE id = $1', [actor.clientId]);
  const projects = await many<{ id: string; name: string; status: string }>(
    q,
    'SELECT id, name, status FROM projects WHERE organization_id = $1 AND client_id = $2 ORDER BY name',
    [actor.organizationId, actor.clientId],
  );
  const budgets = new Map((await listBudgets(deps, q, actor.organizationId)).map((b) => [b.project_id, b]));
  const out: ClientPortalProject[] = [];
  const shown = new Set<string>();
  for (const p of projects) {
    const rep = await projectReport(q, actor.organizationId, p.id, r, tz);
    const seconds = rep.members.reduce((n, m) => n + m.seconds, 0);
    const b = budgets.get(p.id);
    if (seconds === 0 && p.status !== 'active' && !b) continue;
    if (settings!.show_people) for (const m of rep.members) shown.add(m.user_id);
    out.push({
      id: p.id,
      name: p.name,
      seconds,
      daily: rep.daily,
      people: settings!.show_people ? rep.members.map((m) => ({ name: m.display_name, seconds: m.seconds })) : null,
      budget: b
        ? {
            kind: b.kind,
            limit_hours: b.limit_hours,
            limit_cents: b.limit_cents,
            currency: b.currency,
            used_seconds: b.used_seconds,
            used_cents: b.used_cents,
            used_percent: b.used_percent,
            status: b.status,
            period: b.period,
          }
        : null,
    });
  }
  // People's hours seen by someone outside the organization: in each person's access log.
  for (const userId of shown) {
    await audit(q, {
      organizationId: actor.organizationId,
      actor,
      action: 'client_portal.view_hours',
      targetType: 'user',
      targetId: userId,
      targetUserId: userId,
      requestId,
      metadata: { from: r.from, to: r.to },
    });
  }
  return { from: r.from, to: r.to, tz, total_seconds: out.reduce((n, p) => n + p.seconds, 0), projects: out };
}

export async function portalInvoices(q: Queryable, actor: ClientActor): Promise<ClientPortalInvoiceSummary[]> {
  return many<ClientPortalInvoiceSummary>(
    q,
    `SELECT i.id, i.number, i.status, i.client_id, c.name AS client_name, i.period_from::text AS period_from, i.period_to::text AS period_to,
            i.currency, i.total_cents, i.issued_at, i.due_date::text AS due_date, i.paid_on::text AS paid_on
     FROM invoices i JOIN clients c ON c.id = i.client_id
     WHERE i.organization_id = $1 AND i.client_id = $2 AND i.status <> 'draft'
     ORDER BY i.issued_at DESC NULLS LAST LIMIT 200`,
    [actor.organizationId, actor.clientId],
  );
}

export async function portalInvoice(deps: Pick<Deps, 'store'>, q: Queryable, actor: ClientActor, id: string): Promise<ClientPortalInvoice> {
  const inv = await getInvoice(q, actor.organizationId, id).catch(() => null);
  if (!inv || inv.client_id !== actor.clientId || inv.status === 'draft') throw errors.notFound('Invoice');
  const { sent_at: _a, sent_to: _b, payment_note: _c, unrated_seconds: _d, created_at: _e, ...rest } = inv;
  return { ...rest, organization_logo_url: await logoUrl(deps, q, actor.organizationId) };
}
