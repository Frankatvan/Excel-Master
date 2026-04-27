import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { createClient } from "@supabase/supabase-js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const MIGRATION_FILE = "supabase/migrations/20260522002000_add_project_serial_metadata.sql";
const REQUIRED_COLUMNS = ["sheet_109_title", "project_sequence"];

function parseArgs(argv) {
  const args = new Set(argv);
  return {
    dryRun: args.has("--dry-run"),
    checkOnly: args.has("--check-only"),
    skipCheck: args.has("--skip-check"),
  };
}

function getProjectRoot(env) {
  return path.resolve(env.AIWB_DEPLOY_PROJECT_ROOT || DEFAULT_PROJECT_ROOT);
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
    return null;
  }

  const separator = trimmed.indexOf("=");
  const key = trimmed.slice(0, separator).trim();
  let value = trimmed.slice(separator + 1).trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return key ? [key, value] : null;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const entries = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map(parseEnvLine)
    .filter(Boolean);

  return Object.fromEntries(entries);
}

function loadEnv(projectRoot) {
  return {
    ...loadEnvFile(path.join(projectRoot, ".env.local")),
    ...loadEnvFile(path.join(projectRoot, ".env.deploy.local")),
    ...process.env,
  };
}

function getMigrationPath(projectRoot) {
  const migrationPath = path.join(projectRoot, MIGRATION_FILE);
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`Missing migration file: ${MIGRATION_FILE}`);
  }
  return migrationPath;
}

function resolveDatabaseUrl(env) {
  return (
    env.SUPABASE_DB_URL ||
    env.DATABASE_URL ||
    env.POSTGRES_URL ||
    env.POSTGRES_PRISMA_URL ||
    ""
  ).trim();
}

function redact(text, secrets) {
  return secrets.reduce((current, secret) => {
    if (!secret) {
      return current;
    }
    return current.split(secret).join("<redacted>");
  }, String(text || ""));
}

function summarizeMigration(migrationPath) {
  const sql = fs.readFileSync(migrationPath, "utf8");
  const columns = REQUIRED_COLUMNS.filter((column) => sql.includes(column));
  return { sql, columns };
}

async function checkProjectColumns(env) {
  const supabaseUrl = (env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || "").trim();
  const serviceRole = (env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (!supabaseUrl || !serviceRole) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for --check-only.");
  }

  const supabase = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await supabase
    .from("projects")
    .select(`id,${REQUIRED_COLUMNS.join(",")}`)
    .limit(1);

  if (error) {
    const message = String(error.message || "");
    if (error.code === "42703" || message.includes("project_sequence") || message.includes("sheet_109_title")) {
      throw new Error(
        `Project registry migration is missing online columns. Apply ${MIGRATION_FILE} before creating new projects.`,
      );
    }
    throw error;
  }
}

function hasSchemaCheckCredentials(env) {
  return Boolean((env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || "").trim() && (env.SUPABASE_SERVICE_ROLE_KEY || "").trim());
}

function applyMigration({ migrationPath, databaseUrl, env }) {
  if (!databaseUrl) {
    throw new Error(
      "SUPABASE_DB_URL is required to apply the migration locally. You can still copy the SQL from the migration file into Supabase SQL Editor.",
    );
  }

  const result = spawnSync(
    "psql",
    [databaseUrl, "--set", "ON_ERROR_STOP=1", "--file", migrationPath],
    {
      cwd: path.dirname(migrationPath),
      env,
      stdio: "pipe",
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const output = redact([result.stdout, result.stderr].filter(Boolean).join("\n"), [databaseUrl]);
  if (output) {
    process.stdout.write(output);
  }

  if (result.error) {
    throw new Error(`psql failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`psql exited with code ${result.status ?? "unknown"}.`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = getProjectRoot(process.env);
  const migrationPath = getMigrationPath(projectRoot);
  const env = loadEnv(projectRoot);
  const databaseUrl = resolveDatabaseUrl(env);
  const { columns } = summarizeMigration(migrationPath);

  console.log(`[project-registry-migration] projectRoot=${projectRoot}`);
  console.log(`[project-registry-migration] migration=${MIGRATION_FILE}`);
  console.log(`[project-registry-migration] columns=${columns.join(",")}`);

  if (options.dryRun) {
    console.log("[project-registry-migration] mode=dry-run");
    console.log("[project-registry-migration] no database changes will be made");
    return;
  }

  if (options.checkOnly) {
    await checkProjectColumns(env);
    console.log("[project-registry-migration] online schema check passed");
    return;
  }

  applyMigration({ migrationPath, databaseUrl, env });
  console.log("[project-registry-migration] migration applied");

  if (!options.skipCheck) {
    if (hasSchemaCheckCredentials(env)) {
      await checkProjectColumns(env);
      console.log("[project-registry-migration] online schema check passed");
    } else {
      console.log("[project-registry-migration] online schema check skipped; missing Supabase REST credentials");
    }
  }
}

main().catch((error) => {
  console.error(`[project-registry-migration] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
