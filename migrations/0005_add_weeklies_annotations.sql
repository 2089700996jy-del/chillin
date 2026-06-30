-- Add annotations column to weeklies table
ALTER TABLE weeklies ADD COLUMN annotations TEXT DEFAULT '[]';
