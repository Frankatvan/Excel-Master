create extension if not exists pgcrypto;

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid,
  spreadsheet_id text,
  type text,
  job_type text,
  status text not null default 'queued',
  progress integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  result_meta jsonb not null default '{}'::jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists jobs_spreadsheet_id_created_at_idx
  on public.jobs (spreadsheet_id, created_at desc);

create index if not exists jobs_job_type_status_created_at_idx
  on public.jobs (job_type, status, created_at desc);

create index if not exists jobs_type_status_created_at_idx
  on public.jobs (type, status, created_at desc);
