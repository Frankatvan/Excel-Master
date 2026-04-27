import fs from "node:fs";
import path from "node:path";

describe("deployment packaging guardrails", () => {
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
});
