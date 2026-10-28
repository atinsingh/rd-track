-- Stage 2: self-serve signup and Stripe billing (commercial model §2–§7).

-- A signup is pending until its email is verified; only then do the org and admin exist.
CREATE TABLE signup_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  display_name    text NOT NULL,
  org_name        text NOT NULL,
  password_hash   text NOT NULL,
  token_hash      text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  completed_at    timestamptz,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL
);
CREATE INDEX signup_requests_email ON signup_requests (lower(email));

ALTER TABLE subscriptions ADD COLUMN provider_subscription_item_id text;
ALTER TABLE subscriptions ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX subscriptions_provider_customer ON subscriptions (provider_customer_id) WHERE provider_customer_id IS NOT NULL;

-- Webhook deliveries are processed at most once.
CREATE TABLE billing_webhook_events (
  provider      text NOT NULL,
  event_id      text NOT NULL,
  event_type    text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
