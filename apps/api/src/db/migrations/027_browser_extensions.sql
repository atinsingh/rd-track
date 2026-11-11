-- Website domains (Pro): which browsers on a computer have the Track extension, as its
-- last heartbeat reported ('chromium', 'firefox'). Only that it is there, never what it saw.
ALTER TABLE devices ADD COLUMN browser_extensions text[] NOT NULL DEFAULT '{}'
  CHECK (browser_extensions <@ ARRAY['chromium', 'firefox']::text[]);
