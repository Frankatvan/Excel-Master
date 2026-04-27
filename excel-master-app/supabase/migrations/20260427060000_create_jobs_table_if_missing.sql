create extension if not exists pgcrypto;

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid,
  spreadsheet_id text,
  type text,
  job_type text,
  operation text,
  status text not null default 'queued',
  lock_token uuid,
  created_by text,
  progress integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  result_meta jsonb not null default '{}'::jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz
);

alter table public.jobs add column if not exists spreadsheet_id text;
alter table public.jobs add column if not exists type text;
alter table public.jobs add column if not exists job_type text;
alter table public.jobs add column if not exists operation text;
alter table public.jobs add column if not exists status text not null default 'queued';
alter table public.jobs add column if not exists lock_token uuid;
alter table public.jobs add column if not exists created_by text;
alter table public.jobs add column if not exists progress integer not null default 0;
alter table public.jobs add column if not exists payload jsonb not null default '{}'::jsonb;
alter table public.jobs add column if not exists result jsonb;
alter table public.jobs add column if not exists result_meta jsonb not null default '{}'::jsonb;
alter table public.jobs add column if not exists error jsonb;
alter table public.jobs add column if not exists started_at timestamptz;
alter table public.jobs add column if not exists heartbeat_at timestamptz;
alter table public.jobs add column if not exists finished_at timestamptz;

create index if not exists jobs_spreadsheet_id_created_at_idx
  on public.jobs (spreadsheet_id, created_at desc);

create index if not exists jobs_job_type_status_created_at_idx
  on public.jobs (job_type, status, created_at desc);

create index if not exists jobs_type_status_created_at_idx
  on public.jobs (type, status, created_at desc);

create table if not exists public.external_import_manifests (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  project_id uuid,
  spreadsheet_id text not null,
  status text not null default 'parsed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  imported_at timestamptz,
  imported_by text,
  result_meta jsonb not null default '{}'::jsonb,
  error jsonb
);

create table if not exists public.external_import_manifest_items (
  id uuid primary key default gen_random_uuid(),
  manifest_id uuid not null references public.external_import_manifests(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  project_id uuid,
  spreadsheet_id text not null,
  source_table text not null,
  source_file_name text,
  source_sheet_name text,
  file_hash text,
  header_signature text,
  imported_at timestamptz,
  imported_by text,
  row_count integer not null default 0,
  column_count integer not null default 0,
  amount_total numeric,
  target_zone_key text,
  resolved_zone_fingerprint text,
  status text not null default 'parsed',
  validation_message text,
  schema_drift jsonb not null default '{}'::jsonb,
  result_meta jsonb not null default '{}'::jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists external_import_manifests_job_id_idx
  on public.external_import_manifests (job_id);

create index if not exists external_import_manifest_items_manifest_id_idx
  on public.external_import_manifest_items (manifest_id);

create index if not exists external_import_manifest_items_spreadsheet_source_idx
  on public.external_import_manifest_items (spreadsheet_id, source_table, imported_at desc);
