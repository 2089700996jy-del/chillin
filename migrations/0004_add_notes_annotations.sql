-- Add annotations column to notes table
ALTER TABLE notes ADD COLUMN annotations TEXT DEFAULT '[]';
