-- Work location (policy `location.capture`): the public IP a session started from and the
-- city/region/country looked up offline from it. Null when capture is off, the IP is private,
-- or no city is known. No GPS.
ALTER TABLE work_sessions
  ADD COLUMN ip           inet,
  ADD COLUMN city         text,
  ADD COLUMN region       text,
  ADD COLUMN country_code text;
