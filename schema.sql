-- We Sell Rugs — messenger schema

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  bio           TEXT,
  avatar_color  TEXT,
  avatar_url    TEXT,
  last_seen     INTEGER,
  banned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL DEFAULT 'dm',   -- 'dm' | 'group'
  name        TEXT,                          -- group name (null for DMs)
  description TEXT,                          -- group description (groups)
  avatar_url  TEXT,                          -- group photo (groups)
  created_by  TEXT,                          -- creator user id (groups)
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS friendships (
  user_a     TEXT NOT NULL,   -- requester
  user_b     TEXT NOT NULL,   -- addressee
  status     TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b)
);
CREATE INDEX IF NOT EXISTS idx_friend_b ON friendships(user_b);
CREATE INDEX IF NOT EXISTS idx_friend_a ON friendships(user_a);

CREATE TABLE IF NOT EXISTS participants (
  conversation_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  last_read_at    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_participants_user ON participants(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  body            TEXT NOT NULL,
  image_url       TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
