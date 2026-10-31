-- Signing in to connect a computer: the desktop app opens a request, the person signs in on
-- the web and confirms it, and the app collects a one-time enrollment code with its secret.
-- Read before anyone is signed in (the app polls without a session), so it has no row-level
-- security, like sso_login_states and signup_requests. Ten minutes, single use.
CREATE TABLE device_link_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_hash      text NOT NULL,
  user_code        text NOT NULL,
  device_name      text NOT NULL,
  os               text NOT NULL CHECK (os IN ('windows', 'macos', 'linux')),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'used')),
  organization_id  uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  expires_at       timestamptz NOT NULL,
  approved_at      timestamptz,
  used_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_link_requests_expiry ON device_link_requests (expires_at);
