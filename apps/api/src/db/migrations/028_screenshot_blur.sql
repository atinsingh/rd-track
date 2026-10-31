-- SCR-12: screenshots blurred on the computer, before upload, when the policy says so.
-- `blurred` is decided at the upload intent from the policy in force; an image the agent
-- doesn't confirm as blurred is discarded, never stored.
ALTER TABLE screenshots ADD COLUMN blurred boolean NOT NULL DEFAULT false;
