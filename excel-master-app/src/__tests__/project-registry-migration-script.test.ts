import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const projectRoot = path.resolve(__dirname, "../..");
const scriptPath = path.join(projectRoot, "scripts/apply_project_registry_migration.mjs");
const migrationFile = "supabase/migrations/20260522002000_add_project_serial_metadata.sql";

function makeTempProject() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-project-registry-migration-"));
  const migrationPath = path.join(tempRoot, migrationFile);
  fs.mkdirSync(path.dirname(migrationPath), { recursive: true });
  fs.writeFileSync(
    migrationPath,
    [
      "ALTER TABLE IF EXISTS projects ADD COLUMN IF NOT EXISTS sheet_109_title TEXT;",
      "ALTER TABLE IF EXISTS projects ADD COLUMN IF NOT EXISTS project_sequence TEXT;",
    ].join("\n"),
  );
  return tempRoot;
}

describe("project registry migration script", () => {
  it("dry-runs the serial metadata migration without requiring database access", () => {
    const tempRoot = makeTempProject();

    const result = spawnSync(process.execPath, [scriptPath, "--dry-run"], {
      cwd: tempRoot,
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH || "",
        AIWB_DEPLOY_PROJECT_ROOT: tempRoot,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("mode=dry-run");
    expect(result.stdout).toContain(migrationFile);
    expect(result.stdout).toContain("sheet_109_title");
    expect(result.stdout).toContain("project_sequence");
  });

  it("applies the migration through psql when a database url is provided", () => {
    const tempRoot = makeTempProject();
    const tempBin = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-project-registry-bin-"));
    const commandLog = path.join(tempRoot, "psql-command.log");
    fs.writeFileSync(
      path.join(tempBin, "psql"),
      [
        "#!/bin/sh",
        `echo "$*" > "${commandLog}"`,
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: tempRoot,
      env: {
        NODE_ENV: "test",
        PATH: `${tempBin}:${process.env.PATH || ""}`,
        AIWB_DEPLOY_PROJECT_ROOT: tempRoot,
        SUPABASE_DB_URL: "postgres://user:secret-password@db.example.com:5432/postgres",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("migration applied");
    expect(result.stdout).not.toContain("secret-password");
    expect(fs.readFileSync(commandLog, "utf8")).toContain(migrationFile);
  });
});
