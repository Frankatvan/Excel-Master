-- Add owner_email to projects so workbook bootstrap can persist creator email.
ALTER TABLE IF EXISTS projects
ADD COLUMN IF NOT EXISTS owner_email TEXT;
