import { z } from 'zod';

// Single sign-on and directory provisioning (slice 6, G26). Pro plan (`sso` entitlement).

/** A DNS label sequence like `example.com`; no scheme, path or wildcard. */
const domainName = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Enter a domain like example.com');

export const ssoDomainRequest = z.strictObject({ domain: domainName });

/** Where the TXT record goes, and what it must say. */
export const SSO_TXT_PREFIX = '_rd-track';
export const SSO_TXT_VALUE_PREFIX = 'rd-track-verification=';

export interface SsoDomainDTO {
  id: string;
  domain: string;
  verified_at: string | null;
  /** Add a TXT record with this name… */
  txt_name: string;
  /** …and this value. */
  txt_value: string;
}

const oidcConnection = z.strictObject({
  protocol: z.literal('oidc'),
  issuer: z.url().max(500),
  client_id: z.string().trim().min(1).max(500),
  /** Required when creating; leave out to keep the stored secret. */
  client_secret: z.string().min(1).max(2000).optional(),
});

/** Largest IdP metadata document accepted (some carry several certificates and logos). */
export const SAML_METADATA_MAX = 200_000;

/**
 * A SAML 2.0 provider: paste its metadata XML, or give the three values by hand. Track
 * reads the entity ID, the HTTP-Redirect sign-in URL and the signing certificates from it.
 */
const samlConnection = z
  .strictObject({
    protocol: z.literal('saml'),
    metadata_xml: z.string().trim().min(1).max(SAML_METADATA_MAX).optional(),
    idp_entity_id: z.string().trim().min(1).max(500).optional(),
    sso_url: z.url().max(2000).optional(),
    /** PEM or bare base64; several when the provider is rolling its key. */
    certificate: z.string().trim().min(1).max(50_000).optional(),
  })
  .refine((v) => v.metadata_xml || (v.idp_entity_id && v.sso_url && v.certificate), {
    message: "Paste the provider's metadata, or enter its entity ID, sign-in URL and certificate",
  });

export const ssoConnectionRequest = z.preprocess(
  // Before SAML there was only OpenID Connect, sent without a protocol.
  (v) => (v && typeof v === 'object' && !('protocol' in v) ? { ...v, protocol: 'oidc' } : v),
  z.discriminatedUnion('protocol', [oidcConnection, samlConnection]),
);
export type SsoConnectionRequest = z.infer<typeof ssoConnectionRequest>;

export type SsoProtocol = 'oidc' | 'saml';

export const ssoOptionsRequest = z.strictObject({
  /** On once a test sign-in has worked; off returns the connection to a draft. */
  active: z.boolean().optional(),
  enforced: z.boolean().optional(),
  jit_provisioning: z.boolean().optional(),
});

export interface SamlIdpDTO {
  entity_id: string;
  sso_url: string;
  /** The signing certificates Track checks assertions against. */
  certificates: { subject: string; expires_at: string }[];
}

export interface SsoConnectionDTO {
  protocol: SsoProtocol;
  /** OpenID Connect only. */
  issuer: string | null;
  client_id: string | null;
  /** SAML only. */
  saml: SamlIdpDTO | null;
  status: 'draft' | 'active';
  enforced: boolean;
  jit_provisioning: boolean;
  tested_at: string | null;
  tested_by_name: string | null;
  updated_at: string;
}

export interface ScimTokenDTO {
  id: string;
  label: string;
  created_at: string;
  created_by_name: string | null;
  last_used_at: string | null;
}

export const scimTokenRequest = z.strictObject({ label: z.string().trim().min(1).max(100) });

export interface SsoSettings {
  connection: SsoConnectionDTO | null;
  domains: SsoDomainDTO[];
  /** Paste into the identity provider as the sign-in redirect URI (OpenID Connect). */
  redirect_uri: string;
  /** What a SAML provider needs about Track: its entity ID, where to post answers, and metadata to import. */
  saml: { entity_id: string; acs_url: string; metadata_url: string };
  scim: { base_url: string; tokens: ScimTokenDTO[] };
}

export const ssoDiscoverRequest = z.strictObject({
  email: z.email().max(320),
  /** A path in the web app to land on afterwards. */
  return_to: z
    .string()
    .max(500)
    // A path on this site: not `//host` or `/\host`, which browsers read as another site.
    .regex(/^\/(?![/\\])[^\s]*$/)
    .optional(),
});

/**
 * How this address signs in. With `sso`, `password_allowed` says whether a password works
 * too (single sign-on not required, or an org admin's way back in).
 */
export type SsoDiscoverResponse = { method: 'password' } | { method: 'sso'; password_allowed: boolean };

/** Send the browser here to sign in at the identity provider. */
export interface SsoStartResponse {
  redirect_url: string;
}

/** Why a sign-in through the identity provider failed; the web shows it on /login. */
export const SSO_ERRORS = {
  expired: 'That sign-in took too long or was already used. Try again.',
  provider: 'Your identity provider did not complete the sign-in.',
  invalid_token: "Your identity provider's answer could not be verified. Ask your admin to check the connection.",
  no_account: 'There is no Track account for this address. Ask your admin to add you.',
  deactivated: 'Your Track account is deactivated. Ask your admin.',
  wrong_person: 'The test sign-in has to be you: sign in to your identity provider as yourself.',
  seats: 'Your organization has no free seats. Ask your admin.',
  start_in_track: 'Start signing in from the Track sign-in page rather than from your identity provider’s app list.',
} as const;
export type SsoErrorCode = keyof typeof SSO_ERRORS;
