-- Additive migration: user profiles (bio + avatar colour). Safe on live data.
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN avatar_color TEXT;
