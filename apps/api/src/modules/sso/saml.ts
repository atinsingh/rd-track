import { X509Certificate } from 'node:crypto';
import { SAML, SamlStatusError, generateServiceProviderMetadata, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml';
import { DOMParser } from '@xmldom/xmldom';
import { randomToken } from '../../lib/crypto';
import { emailOf, nameOf, type IdClaims } from './oidc';

/**
 * SAML 2.0 for single sign-on (G26), next to OpenID Connect. Track is the service provider:
 * it sends an unsigned AuthnRequest over HTTP-Redirect and takes the answer over HTTP-POST.
 * The answer must be signed (the Response, or the assertion in it) by one of the
 * provider's certificates, name Track as its audience, answer this very request, and come
 * from the provider's entity ID. Encrypted assertions aren't accepted: Track publishes no
 * encryption key, and TLS already protects the answer on its way.
 */

export class SamlError extends Error {
  /** The provider answered with a failure status (the person cancelled, wasn't allowed, …). */
  refused = false;
}

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';
const EMAIL_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

export interface SamlIdp {
  entityId: string;
  ssoUrl: string;
  certificates: string[];
}

export interface SamlSp {
  entityId: string;
  acsUrl: string;
}

export const spFor = (webUrl: string, orgId: string): SamlSp & { metadataUrl: string } => ({
  // The entity ID is also where the metadata is, so pasting it into a provider imports it.
  entityId: `${webUrl}/v1/auth/sso/saml/${orgId}`,
  metadataUrl: `${webUrl}/v1/auth/sso/saml/${orgId}`,
  acsUrl: `${webUrl}/v1/auth/sso/saml/${orgId}/acs`,
});

function parseXml(xml: string): Document {
  // No DTDs at all: nothing to expand, nothing to fetch.
  if (/<!DOCTYPE/i.test(xml)) throw new SamlError('The metadata must not contain a DOCTYPE');
  let problem: string | null = null;
  const doc = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: (m: string) => (problem ??= m),
      fatalError: (m: string) => (problem ??= m),
    },
  }).parseFromString(xml, 'text/xml');
  if (problem || !doc?.documentElement) throw new SamlError("That isn't valid XML");
  return doc as unknown as Document;
}

/** xmldom's node lists are array-like, not iterable. */
const all = (parent: Document | Element, ns: string, name: string): Element[] => Array.from(parent.getElementsByTagNameNS(ns, name) as ArrayLike<Element>);

const pem = (b64: string) => `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;

/** PEM blocks or bare base64 certificates → checked PEM certificates. */
export function readCertificates(text: string): string[] {
  const blocks = [...text.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map((m) => m[1]!);
  const raw = blocks.length ? blocks : text.split(/\n\s*\n/);
  const out = raw
    .map((b) => b.replace(/\s+/g, ''))
    .filter(Boolean)
    .map((b) => {
      if (!/^[A-Za-z0-9+/]+=*$/.test(b)) throw new SamlError("The certificate isn't in PEM or base64 form");
      const p = pem(b);
      try {
        new X509Certificate(p);
      } catch {
        throw new SamlError("The certificate couldn't be read");
      }
      return p;
    });
  if (!out.length) throw new SamlError('Add the signing certificate');
  return [...new Set(out)].slice(0, 5);
}

export function certificateInfo(p: string): { subject: string; expires_at: string } {
  const c = new X509Certificate(p);
  return { subject: c.subject.replace(/\n/g, ', '), expires_at: new Date(c.validTo).toISOString() };
}

/** Reads the provider's entity ID, HTTP-Redirect sign-in URL and signing certificates from its metadata. */
export function parseIdpMetadata(xml: string): SamlIdp {
  const doc = parseXml(xml);
  const entity = all(doc, MD, 'EntityDescriptor').find((e) => all(e, MD, 'IDPSSODescriptor').length > 0);
  if (!entity) throw new SamlError("The metadata doesn't describe an identity provider (no IDPSSODescriptor)");
  const entityId = entity.getAttribute('entityID')?.trim();
  if (!entityId) throw new SamlError('The metadata has no entityID');
  const idp = all(entity, MD, 'IDPSSODescriptor')[0]!;
  const sso = all(idp, MD, 'SingleSignOnService').find((e) => e.getAttribute('Binding') === REDIRECT);
  const ssoUrl = sso?.getAttribute('Location')?.trim();
  if (!ssoUrl) throw new SamlError('The metadata has no sign-in URL for the HTTP-Redirect binding');
  const certs = all(idp, MD, 'KeyDescriptor')
    .filter((k) => (k.getAttribute('use') || 'signing') === 'signing')
    .flatMap((k) => all(k, DS, 'X509Certificate').map((c) => c.textContent ?? ''));
  if (!certs.length) throw new SamlError('The metadata has no signing certificate');
  return { entityId, ssoUrl, certificates: readCertificates(certs.join('\n\n')) };
}

/** Track's own metadata, for importing into the provider. */
export function spMetadata(sp: SamlSp): string {
  return generateServiceProviderMetadata({ issuer: sp.entityId, callbackUrl: sp.acsUrl, identifierFormat: EMAIL_FORMAT, wantAssertionsSigned: true });
}

/** node-saml keeps request IDs in a cache; here there's exactly one, kept with the sign-in state. */
function oneRequest(id: string): CacheProvider {
  return {
    saveAsync: async (key, value) => ({ value, createdAt: Date.now() }),
    getAsync: async (key) => (key === id ? new Date().toISOString() : null),
    removeAsync: async (key) => key,
  };
}

function client(sp: SamlSp, idp: SamlIdp, requestId: string): SAML {
  return new SAML({
    issuer: sp.entityId,
    callbackUrl: sp.acsUrl,
    audience: sp.entityId,
    entryPoint: idp.ssoUrl,
    idpCert: idp.certificates,
    idpIssuer: idp.entityId,
    // Let the provider choose the name ID format, and how people authenticate (its own MFA).
    identifierFormat: null,
    disableRequestedAuthnContext: true,
    // A signed Response covers its assertion; otherwise the assertion itself must be signed.
    wantAuthnResponseSigned: false,
    wantAssertionsSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    cacheProvider: oneRequest(requestId),
    generateUniqueId: () => requestId,
    acceptedClockSkewMs: 60_000,
    maxAssertionAgeMs: 10 * 60_000,
  });
}

export const newRequestId = () => `_${randomToken(24)}`;

/** The provider's sign-in URL with an AuthnRequest for `requestId`, carrying `relayState` back. */
export function authnRequestUrl(sp: SamlSp, idp: SamlIdp, requestId: string, relayState: string): Promise<string> {
  return client(sp, idp, requestId).getAuthorizeUrlAsync(relayState, undefined, {});
}

export interface SamlIdentity {
  /** Stable name for the person at the provider (the name ID, or their address when it's transient). */
  sub: string;
  email: string | null;
  name: string | null;
}

const first = (v: unknown): string | undefined => {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === 'string' && x.trim() ? x.trim() : undefined;
};
const attr = (p: Profile, names: string[]) => names.map((n) => first(p[n])).find(Boolean);

const EMAIL_ATTRS = ['email', 'mail', 'emailAddress', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', 'urn:oid:0.9.2342.19200300.100.1.3'];
const NAME_ATTRS = ['displayName', 'http://schemas.microsoft.com/identity/claims/displayname', 'urn:oid:2.16.840.1.113730.3.1.241', 'name'];
const GIVEN_ATTRS = ['givenName', 'firstName', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname', 'urn:oid:2.5.4.42'];
const FAMILY_ATTRS = ['sn', 'surname', 'lastName', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname', 'urn:oid:2.5.4.4'];

/** The person a profile names, in the same shape OpenID Connect claims are read in. */
export function identityOf(p: Profile): SamlIdentity {
  const claims: IdClaims = {
    iss: p.issuer,
    sub: p.nameID,
    aud: '',
    exp: 0,
    email: attr(p, EMAIL_ATTRS) ?? (p.nameIDFormat === EMAIL_FORMAT || /@/.test(p.nameID) ? p.nameID : undefined),
    name: attr(p, NAME_ATTRS),
    given_name: attr(p, GIVEN_ATTRS),
    family_name: attr(p, FAMILY_ATTRS),
  };
  const email = emailOf(claims);
  // A transient name ID changes every time, so it can't be bound to the person.
  const sub = p.nameIDFormat === TRANSIENT ? (email ? `email:${email}` : '') : p.nameID;
  if (!sub) throw new SamlError('The answer names nobody: no persistent name ID and no email address');
  return { sub, email, name: email ? nameOf(claims, email) : null };
}

/** Checks the provider's posted answer to `requestId` and reads who signed in. */
export async function readResponse(sp: SamlSp, idp: SamlIdp, requestId: string, samlResponse: string): Promise<SamlIdentity> {
  let profile: Profile | null;
  try {
    ({ profile } = await client(sp, idp, requestId).validatePostResponseAsync({ SAMLResponse: samlResponse }));
  } catch (e) {
    const err = new SamlError(e instanceof Error ? e.message : 'invalid response');
    err.refused = e instanceof SamlStatusError;
    throw err;
  }
  if (!profile) throw new SamlError('The answer has no assertion');
  // node-saml checks the Issuer of logout messages only; check the assertion's here.
  if (profile.issuer !== idp.entityId) throw new SamlError(`Unexpected issuer ${profile.issuer}`);
  return identityOf(profile);
}
