-- Additive migration: uploaded profile picture URL.
ALTER TABLE users ADD COLUMN avatar_url TEXT;
