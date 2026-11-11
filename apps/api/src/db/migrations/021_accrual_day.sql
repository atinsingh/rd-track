-- Stage 4 F9: which day of each period time off is credited.
-- first: the 1st of the month (or 1 January); last: the last day of the month (or 31 December);
-- anniversary: the day of the month (or the date in the year) the person's assignment started.
ALTER TABLE time_off_policies
  ADD COLUMN accrual_day text NOT NULL DEFAULT 'first' CHECK (accrual_day IN ('first', 'anniversary', 'last'));
