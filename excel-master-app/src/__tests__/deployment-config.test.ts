import fs from "node:fs";
import path from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";

import debugEnvHandler from "../pages/api/debug-env";

function createMockRes() {
  const res = {} as Partial<NextApiResponse>;
  res.status = jest.fn().mockReturnValue(res as NextApiResponse);
  res.json = jest.fn().mockReturnValue(res as NextApiResponse);
  return res as NextApiResponse;
}

describe("deployment packaging guardrails", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("ignores local build artifacts and python caches from Vercel uploads", () => {
    const projectRoot = path.resolve(__dirname, "../..");
    const ignorePath = path.join(projectRoot, ".vercelignore");

    expect(fs.existsSync(ignorePath)).toBe(true);

    const ignoreRules = fs.readFileSync(ignorePath, "utf8");

    expect(ignoreRules).toContain(".next");
    expect(ignoreRules).toContain("__pycache__");
    expect(ignoreRules).toContain("*.pyc");
  });

  it("declares python worker function settings for the internal reclassify worker", () => {
    const projectRoot = path.resolve(__dirname, "../..");
    const vercelConfigPath = path.join(projectRoot, "vercel.json");

    expect(fs.existsSync(vercelConfigPath)).toBe(true);

    const vercelConfig = JSON.parse(fs.readFileSync(vercelConfigPath, "utf8"));
    const functions = vercelConfig.functions || {};

    expect(functions).toEqual(
      expect.objectContaining({
        "api/internal/reclassify_job.py": expect.objectContaining({
          maxDuration: expect.any(Number),
        }),
      }),
    );
  });

  it("declares enough runtime for the audit sync API background task", () => {
    const projectRoot = path.resolve(__dirname, "../..");
    const vercelConfigPath = path.join(projectRoot, "vercel.json");

    expect(fs.existsSync(vercelConfigPath)).toBe(true);

    const vercelConfig = JSON.parse(fs.readFileSync(vercelConfigPath, "utf8"));
    const functions = vercelConfig.functions || {};

    expect(functions).toEqual(
      expect.objectContaining({
        "src/pages/api/audit_sync.ts": expect.objectContaining({
          maxDuration: expect.any(Number),
        }),
      }),
    );
  });

  it("declares enough runtime for validate input action and bootstrap worker", () => {
    const projectRoot = path.resolve(__dirname, "../..");
    const vercelConfigPath = path.join(projectRoot, "vercel.json");

    expect(fs.existsSync(vercelConfigPath)).toBe(true);

    const vercelConfig = JSON.parse(fs.readFileSync(vercelConfigPath, "utf8"));
    const functions = vercelConfig.functions || {};

    expect(functions).toEqual(
      expect.objectContaining({
        "src/pages/api/projects/action.ts": expect.objectContaining({
          maxDuration: expect.any(Number),
        }),
        "api/project_bootstrap.py": expect.objectContaining({
          maxDuration: expect.any(Number),
        }),
      }),
    );
  });

  it("includes a migration for project serial metadata columns", () => {
    const projectRoot = path.resolve(__dirname, "../..");
    const migrationsDir = path.join(projectRoot, "supabase/migrations");

    const migrationText = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .map((file) => fs.readFileSync(path.join(migrationsDir, file), "utf8"))
      .join("\n");

    expect(migrationText).toContain("project_sequence");
    expect(migrationText).toContain("sheet_109_title");
  });

  it("ships a current jobs table migration for formula sync", () => {
    const projectRoot = path.resolve(__dirname, "../..");
    const migrationsDir = path.join(projectRoot, "supabase/migrations");
    const migrationNames = fs.readdirSync(migrationsDir);

    expect(migrationNames).toContain("20260427060000_create_jobs_table_if_missing.sql");
  });

  it("declares durable external import job and manifest tables", () => {
    const projectRoot = path.resolve(__dirname, "../..");
    const migrationPath = path.join(projectRoot, "supabase/migrations/20260427060000_create_jobs_table_if_missing.sql");
    const migration = fs.readFileSync(migrationPath, "utf8");

    for (const token of [
      "operation text",
      "lock_token uuid",
      "created_by text",
      "heartbeat_at timestamptz",
      "public.external_import_manifests",
      "public.external_import_manifest_items",
      "schema_drift jsonb",
    ]) {
      expect(migration).toContain(token);
    }
  });

  it("ships python dependencies required by the worker runtime", () => {
    const projectRoot = path.resolve(__dirname, "../..");
    const requirementsPath = path.join(projectRoot, "requirements.txt");

    expect(fs.existsSync(requirementsPath)).toBe(true);

    const requirements = fs.readFileSync(requirementsPath, "utf8");

    expect(requirements).toContain("pandas");
    expect(requirements).toContain("google-api-python-client");
  });

  it("provides a fast production deploy path that skips env re-sync", () => {
    const projectRoot = path.resolve(__dirname, "../..");
    const packageJsonPath = path.join(projectRoot, "package.json");

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

    expect(packageJson.scripts).toEqual(
      expect.objectContaining({
        "deploy:prod:fast": "node scripts/vercel_deploy.mjs --prod --skip-env-sync",
        "deploy:prod:fast:dry": "node scripts/vercel_deploy.mjs --prod --skip-env-sync --dry-run",
      }),
    );
  });

  it("provides project registry migration commands for production schema upkeep", () => {
    const projectRoot = path.resolve(__dirname, "../..");
    const packageJsonPath = path.join(projectRoot, "package.json");

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

    expect(packageJson.scripts).toEqual(
      expect.objectContaining({
        "db:project-registry:check": "node scripts/apply_project_registry_migration.mjs --check-only",
        "db:project-registry:migrate:dry": "node scripts/apply_project_registry_migration.mjs --dry-run",
        "db:project-registry:migrate": "node scripts/apply_project_registry_migration.mjs",
      }),
    );
  });

  it("requires external import worker credentials in deploy scripts", () => {
    const projectRoot = path.resolve(__dirname, "../..");

    for (const scriptPath of [
      path.join(projectRoot, "scripts/vercel_env_sync.mjs"),
      path.join(projectRoot, "scripts/vercel_deploy.mjs"),
    ]) {
      const script = fs.readFileSync(scriptPath, "utf8");

      expect(script).toContain('"EXTERNAL_IMPORT_WORKER_URL"');
      expect(script).toContain('"EXTERNAL_IMPORT_WORKER_SECRET"');
    }
  });

  it("reports external import worker readiness without exposing secret values", () => {
    process.env.EXTERNAL_IMPORT_WORKER_URL = "https://worker.example.com/api/external-import";
    process.env.EXTERNAL_IMPORT_WORKER_SECRET = "super-secret-external-import-token";

    const req = {} as NextApiRequest;
    const res = createMockRes();

    debugEnvHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as jest.Mock).mock.calls[0][0];

    expect(payload).toEqual(
      expect.objectContaining({
        hasExternalImportWorkerUrl: true,
        hasExternalImportWorkerSecret: true,
      }),
    );
    expect(JSON.stringify(payload)).not.toContain("super-secret-external-import-token");
  });
});
