-- Disappearing messages: per-conversation timer + per-message expiry.
ALTER TABLE conversations ADD COLUMN disappear_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN expires_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at);
