-- Plain display name of the commenter, kept ONLY for items that become leads, so the owner can find the
-- comment on the source site to reply. Every other item keeps just the salted-free author hash.
ALTER TABLE items ADD COLUMN author_name TEXT;
