-- Moderation: ability to suspend (ban) a user.
ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;
