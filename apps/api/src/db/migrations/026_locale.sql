-- G27: language and formats. An organization's default, and each person's own choice;
-- NULL follows the default (for the organization, each browser's languages).
ALTER TABLE organizations ADD COLUMN locale text CHECK (locale ~ '^[a-z]{2}-[A-Z]{2}$');
ALTER TABLE users ADD COLUMN locale text CHECK (locale ~ '^[a-z]{2}-[A-Z]{2}$');
