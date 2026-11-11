-- Slice 4b (docs/design/07-product-review.md, G14–G15): teams can be archived once they
-- have nobody left in them. Archived teams leave every list and picker; their history
-- (memberships, reports by date) stays.

SELECT set_config('rd.org_id', '*', true);

ALTER TABLE teams ADD COLUMN archived_at timestamptz;
