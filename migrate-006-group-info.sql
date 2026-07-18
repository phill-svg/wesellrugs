-- Additive migration: group chat description + photo.
ALTER TABLE conversations ADD COLUMN description TEXT;
ALTER TABLE conversations ADD COLUMN avatar_url TEXT;
