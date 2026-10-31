-- Engine slice 4 (docs/design/07-product-review.md §4): role workspaces.
-- A finance role for Money without full admin (G21), and payment tracking on issued
-- invoices (G23).

SELECT set_config('rd.org_id', '*', true);

ALTER TABLE users DROP CONSTRAINT users_org_role_check;
ALTER TABLE users ADD CONSTRAINT users_org_role_check
  CHECK (org_role IN ('employee', 'org_admin', 'auditor', 'super_admin', 'finance'));

-- Payment and delivery facts about an issued invoice. They don't change what was billed,
-- so the lock below lets them change after issue; lines and amounts stay frozen.
ALTER TABLE invoices
  ADD COLUMN paid_on       date,
  ADD COLUMN payment_note  text,
  ADD COLUMN sent_at       timestamptz,
  ADD COLUMN sent_to       text,
  ADD CONSTRAINT invoices_paid_issued CHECK (paid_on IS NULL OR status <> 'draft');

CREATE OR REPLACE FUNCTION invoices_lock() RETURNS trigger AS $$
DECLARE
  fixed text[] := ARRAY['status', 'voided_at', 'void_reason', 'updated_at', 'created_by',
                        'paid_on', 'payment_note', 'sent_at', 'sent_to'];
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - fixed) IS DISTINCT FROM (to_jsonb(OLD) - fixed)
     OR (OLD.status = 'issued' AND NEW.status NOT IN ('issued', 'void'))
     OR (OLD.status = 'void' AND (NEW.status <> 'void' OR NEW.voided_at IS DISTINCT FROM OLD.voided_at
                                  OR NEW.void_reason IS DISTINCT FROM OLD.void_reason
                                  OR NEW.paid_on IS DISTINCT FROM OLD.paid_on)) THEN
    RAISE EXCEPTION 'invoice % is %; it can only be voided or have its payment recorded', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE INDEX invoices_open ON invoices (organization_id, status) WHERE paid_on IS NULL;
