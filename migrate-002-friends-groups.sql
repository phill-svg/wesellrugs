-- Additive migration: friends + group chats. Safe to run on the live DB.

-- conversations gains a type ('dm' | 'group'), an optional name, and a creator.
ALTER TABLE conversations ADD COLUMN type TEXT NOT NULL DEFAULT 'dm';
ALTER TABLE conversations ADD COLUMN name TEXT;
ALTER TABLE conversations ADD COLUMN created_by TEXT;

-- Friendships: one row per pair. user_a is the requester, user_b the addressee.
CREATE TABLE IF NOT EXISTS friendships (
  user_a     TEXT NOT NULL,
  user_b     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b)
);
CREATE INDEX IF NOT EXISTS idx_friend_b ON friendships(user_b);
CREATE INDEX IF NOT EXISTS idx_friend_a ON friendships(user_a);
