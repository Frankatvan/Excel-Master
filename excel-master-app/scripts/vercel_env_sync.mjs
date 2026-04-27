import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_VERCEL_CLI_VERSION = "52.0.0";
const DEFAULT_NPM_CACHE = "/tmp/npm-cache";

const REQUIRED_KEYS = [
  "NEXTAUTH_URL",
  "NEXTAUTH_SECRET",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_CLIENT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
  "GOOGLE_SHEET_ID",
  "GOOGLE_SHEET_TEMPLATE_ID",
  "AIWB_WORKER_SECRET",
  "EXTERNAL_IMPORT_WORKER_URL",
  "EXTERNAL_IMPORT_WORKER_SECRET",
];

function parseArgs(argv) {
  const args = new Set(argv);
  return {
    prod: args.has("--prod") || args.has("--production"),
    dryRun: args.has("--dry-run"),
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

  return Object.fromEntries(
    fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map(parseEnvLine)
      .filter(Boolean),
  );
}

function readProjectLink(projectRoot) {
  const projectPath = path.join(projectRoot, ".vercel", "project.json");
  if (!fs.existsSync(projectPath)) {
    throw new Error("Missing .vercel/project.json. Run `npx vercel link` from excel-master-app first.");
  }

  return JSON.parse(fs.readFileSync(projectPath, "utf8"));
}

function validateUrlEnv(key, value, errors) {
  try {
    new URL(value.trim());
  } catch {
    errors.push(`${key} is not a valid URL`);
  }
}

function loadRequiredLocalEnv(projectRoot) {
  const envPath = path.join(projectRoot, ".env.local");
  const env = loadEnvFile(envPath);
  const errors = [];

  if (!fs.existsSync(envPath)) {
    errors.push(".env.local is missing");
  }

  for (const key of REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      errors.push(`${key} is missing`);
    } else if (!String(env[key] || "").trim()) {
      errors.push(`${key} is empty`);
    }
  }

  for (const key of ["NEXTAUTH_URL", "NEXT_PUBLIC_SUPABASE_URL"]) {
    if (String(env[key] || "").trim()) {
      validateUrlEnv(key, String(env[key] || ""), errors);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      "Invalid local environment in .env.local:\n" +
        errors.map((error) => `- ${error}`).join("\n"),
    );
  }

  return Object.fromEntries(REQUIRED_KEYS.map((key) => [key, String(env[key]).trim()]));
}

function resolveToken(env, dryRun) {
  const token = (env.VERCEL_TOKEN || "").trim();
  if (token || dryRun) {
    return token;
  }

  throw new Error("VERCEL_TOKEN is required to sync Vercel environment variables.");
}

function commandToString(args, token) {
  return args.map((arg) => (arg === token ? "<redacted>" : arg)).join(" ");
}

function syncVariable({ key, value, target, token, cliVersion, projectRoot, runtimeEnv, dryRun }) {
  const args = [
    "--yes",
    `vercel@${cliVersion}`,
    "env",
    "add",
    key,
    target,
    "--force",
    "--yes",
    "--token",
    token,
  ];

  if (dryRun) {
    console.log(`[env-sync] would sync ${key} to ${target}`);
    return;
  }

  console.log(`[env-sync] syncing ${key} to ${target}`);
  const result = spawnSync("npx", args, {
    cwd: projectRoot,
    env: runtimeEnv,
    input: value,
    stdio: "pipe",
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `Failed to sync ${key}. Command: npx ${commandToString(args, token)}\n${output}`,
    );
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = options.prod ? "production" : "preview";
  const projectRoot = getProjectRoot(process.env);
  const projectLink = readProjectLink(projectRoot);
  const localEnv = loadRequiredLocalEnv(projectRoot);
  const token = resolveToken(process.env, options.dryRun);
  const cliVersion = (process.env.VERCEL_CLI_VERSION || DEFAULT_VERCEL_CLI_VERSION).trim();
  const runtimeEnv = {
    ...process.env,
    NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE || DEFAULT_NPM_CACHE,
  };
  fs.mkdirSync(runtimeEnv.NPM_CONFIG_CACHE, { recursive: true });

  console.log(`[env-sync] project=${projectLink.projectName || "unknown"}`);
  console.log(`[env-sync] target=${target}`);
  console.log(`[env-sync] variables=${REQUIRED_KEYS.length}`);

  for (const [key, value] of Object.entries(localEnv)) {
    syncVariable({
      key,
      value,
      target,
      token,
      cliVersion,
      projectRoot,
      runtimeEnv,
      dryRun: options.dryRun,
    });
  }
}

try {
  main();
} catch (error) {
  console.error(`[env-sync] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
