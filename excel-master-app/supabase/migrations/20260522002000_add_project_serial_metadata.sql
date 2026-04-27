-- Add project serial metadata used to map project registrations to their main sheet.
ALTER TABLE IF EXISTS projects
ADD COLUMN IF NOT EXISTS sheet_109_title TEXT;

ALTER TABLE IF EXISTS projects
ADD COLUMN IF NOT EXISTS project_sequence TEXT;

CREATE INDEX IF NOT EXISTS projects_sheet_109_title_idx
ON projects (sheet_109_title);

CREATE INDEX IF NOT EXISTS projects_project_sequence_idx
ON projects (project_sequence);
