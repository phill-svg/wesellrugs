-- Additive migration: track read state per participant for unread counts / notifications.
ALTER TABLE participants ADD COLUMN last_read_at INTEGER NOT NULL DEFAULT 0;
