-- What each acceptance covers: the policies the agreement text was generated from on that
-- computer (base + each project, with the device's own policy). Tracking needs an acceptance
-- that covers everything collected now (consentCovers), so only collecting more asks again;
-- text_sha256 stays the proof of exactly what was shown. Older rows have none and cover nothing.
-- consent_records stays append-only; adding a column rewrites no row.

ALTER TABLE consent_records ADD COLUMN collected jsonb;
ALTER TABLE consent_records ADD CONSTRAINT consent_records_accepted_collected
  CHECK (decision = 'declined' OR collected IS NOT NULL) NOT VALID;
