-- Reactions, replies, and voice messages.
CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id);

ALTER TABLE messages ADD COLUMN reply_to TEXT;
ALTER TABLE messages ADD COLUMN reply_sender TEXT;
ALTER TABLE messages ADD COLUMN reply_snippet TEXT;
ALTER TABLE messages ADD COLUMN audio_url TEXT;
