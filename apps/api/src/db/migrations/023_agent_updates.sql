-- G10: how the desktop app updates in this organization.
-- prompt: people see "Version x is ready" and restart when it suits them (the default);
-- auto: the app installs it by itself when no session is running;
-- hold: no updates are offered (an admin tests a release first, or IT deploys the MSI).
ALTER TABLE organizations
  ADD COLUMN agent_update_mode text NOT NULL DEFAULT 'prompt' CHECK (agent_update_mode IN ('prompt', 'auto', 'hold'));
