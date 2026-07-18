-- Additive migration: presence (last_seen) + image messages.
ALTER TABLE users ADD COLUMN last_seen INTEGER;
ALTER TABLE messages ADD COLUMN image_url TEXT;
