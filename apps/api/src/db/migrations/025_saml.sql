-- G26: single sign-on through a SAML 2.0 identity provider, next to OpenID Connect.

-- One connection per organization still; it speaks one protocol or the other.
ALTER TABLE sso_connections
  ADD COLUMN protocol text NOT NULL DEFAULT 'oidc' CHECK (protocol IN ('oidc', 'saml')),
  -- The provider's entity ID (the Issuer of its assertions), where it signs people in
  -- (HTTP-Redirect binding), and its signing certificates as PEM (more than one while it rolls keys).
  ADD COLUMN saml_idp_entity_id text,
  ADD COLUMN saml_sso_url text,
  ADD COLUMN saml_certificates text;
ALTER TABLE sso_connections ALTER COLUMN issuer DROP NOT NULL, ALTER COLUMN client_id DROP NOT NULL, ALTER COLUMN client_secret_enc DROP NOT NULL;
ALTER TABLE sso_connections ADD CONSTRAINT sso_connections_protocol_fields CHECK (
  CASE protocol
    WHEN 'oidc' THEN issuer IS NOT NULL AND client_id IS NOT NULL AND client_secret_enc IS NOT NULL
    ELSE saml_idp_entity_id IS NOT NULL AND saml_sso_url IS NOT NULL AND saml_certificates IS NOT NULL
  END
);

-- A SAML sign-in has no nonce or PKCE verifier. The provider posts its answer to Track
-- cross-site, where the browser cookie isn't sent, so the checked answer waits here until
-- that browser comes back with a same-site GET.
ALTER TABLE sso_login_states ALTER COLUMN nonce DROP NOT NULL, ALTER COLUMN code_verifier DROP NOT NULL;
ALTER TABLE sso_login_states
  ADD COLUMN saml_request_id text,
  ADD COLUMN saml_result jsonb,
  ADD COLUMN saml_received_at timestamptz;
