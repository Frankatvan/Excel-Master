import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_VERCEL_CLI_VERSION = "52.0.0";
const DEFAULT_NPM_CACHE = "/tmp/npm-cache";
const DEFAULT_VERCEL_HOME = "/tmp/vercel-home";
const DEFAULT_UV_PYTHON_INSTALL_DIR = "/tmp/uv-python";
const DEFAULT_DEPLOY_GIT_DIR = "/tmp/aiwb-vercel-deploy-no-git";
const REQUIRED_ENV_KEYS = [
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

const OPTIONAL_ENV_KEYS = [
  "VERCEL_AUTOMATION_BYPASS_SECRET",
];

function parseArgs(argv) {
  const args = new Set(argv);
  return {
    prod: args.has("--prod") || args.has("--production"),
    dryRun: args.has("--dry-run"),
    checkEnvOnly: args.has("--check-env-only"),
    skipEnvSync: args.has("--skip-env-sync"),
  };
}

function getProjectRoot(env) {
  return path.resolve(env.AIWB_DEPLOY_PROJECT_ROOT || DEFAULT_PROJECT_ROOT);
}

function getDeployGitDir(env) {
  return path.resolve(env.AIWB_DEPLOY_GIT_DIR || DEFAULT_DEPLOY_GIT_DIR);
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

function loadDeployEnv(projectRoot) {
  return {
    ...loadEnvFile(path.join(projectRoot, ".env.deploy.local")),
    ...process.env,
  };
}

function readProjectLink(projectRoot) {
  const projectPath = path.join(projectRoot, ".vercel", "project.json");
  if (!fs.existsSync(projectPath)) {
    throw new Error("Missing .vercel/project.json. Run `npx vercel link` from excel-master-app first.");
  }

  return JSON.parse(fs.readFileSync(projectPath, "utf8"));
}

function validateUrlEnv(key, value, errors) {
  if (!value.trim()) {
    errors.push(`${key} is empty`);
    return;
  }

  try {
    new URL(value.trim());
  } catch {
    errors.push(`${key} is not a valid URL`);
  }
}

function validateLocalBuildEnv(projectRoot) {
  const envPath = path.join(projectRoot, ".env.local");
  const env = loadEnvFile(envPath);
  const errors = [];

  if (!fs.existsSync(envPath)) {
    errors.push(".env.local is missing");
  }

  for (const key of REQUIRED_ENV_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      errors.push(`${key} is missing`);
    } else if (!String(env[key] || "").trim()) {
      errors.push(`${key} is empty`);
    }
  }

  for (const key of ["NEXTAUTH_URL", "NEXT_PUBLIC_SUPABASE_URL"]) {
    if (Object.prototype.hasOwnProperty.call(env, key) && String(env[key] || "").trim()) {
      validateUrlEnv(key, String(env[key] || ""), errors);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      "Invalid local environment in .env.local:\n" +
        errors.map((error) => `- ${error}`).join("\n"),
    );
  }

  return Object.fromEntries([
    ...REQUIRED_ENV_KEYS.map((key) => [key, String(env[key]).trim()]),
    ...OPTIONAL_ENV_KEYS
      .filter((key) => String(env[key] || "").trim())
      .map((key) => [key, String(env[key]).trim()]),
  ]);
}

function loadRequiredLocalEnv(projectRoot) {
  const envPath = path.join(projectRoot, ".env.local");
  const env = loadEnvFile(envPath);
  const errors = [];

  if (!fs.existsSync(envPath)) {
    errors.push(".env.local is missing");
  }

  for (const key of REQUIRED_ENV_KEYS) {
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

  return Object.fromEntries([
    ...REQUIRED_ENV_KEYS.map((key) => [key, String(env[key]).trim()]),
    ...OPTIONAL_ENV_KEYS
      .filter((key) => String(env[key] || "").trim())
      .map((key) => [key, String(env[key]).trim()]),
  ]);
}

function resolveToken(env) {
  const token = (env.VERCEL_TOKEN || "").trim();
  if (token) {
    return token;
  }

  if ((env.VERCEL_OIDC_TOKEN || "").trim()) {
    throw new Error(
      "VERCEL_TOKEN is required. VERCEL_OIDC_TOKEN is not a Vercel CLI access token; it is a runtime/deployment OIDC token.",
    );
  }

  throw new Error(
    "VERCEL_TOKEN is required. Create a Vercel Access Token and set it in your shell or .env.deploy.local.",
  );
}

function ensureLocalDirs(env) {
  for (const dir of [env.NPM_CONFIG_CACHE, env.HOME, env.UV_PYTHON_INSTALL_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function commandToString(args, token) {
  return args.map((arg) => (arg === token ? "<redacted>" : arg)).join(" ");
}

function redactText(text, token) {
  if (!text) {
    return "";
  }

  return String(text).split(token).join("<redacted>");
}

function buildSteps({ prod, token, cliVersion, projectRoot, deployGitDir }) {
  const environment = prod ? "production" : "preview";
  const targetFlag = prod ? "--prod" : "";
  const cliPackage = `vercel@${cliVersion}`;
  const deployGitOverrides = {
    GIT_DIR: path.join(deployGitDir, ".git"),
    GIT_WORK_TREE: path.join(deployGitDir, "work-tree"),
  };

  return [
    {
      label: "Pull Vercel environment",
      cwd: projectRoot,
      args: ["--yes", cliPackage, "pull", "--yes", `--environment=${environment}`, "--token", token],
    },
    {
      label: "Deploy source",
      cwd: projectRoot,
      disablesGitMetadata: true,
      envOverrides: deployGitOverrides,
      args: [
        "--yes",
        cliPackage,
        "deploy",
        "--archive=tgz",
        ...(targetFlag ? [targetFlag] : []),
        "--yes",
        "--token",
        token,
      ],
    },
  ];
}

function syncVariable({ key, value, target, token, cliVersion, env, dryRun, projectRoot }) {
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
    console.log(`[deploy] would sync ${key} to ${target}`);
    return;
  }

  console.log(`[deploy] syncing ${key} to ${target}`);
  const result = spawnSync("npx", args, {
    cwd: projectRoot,
    env,
    input: value,
    stdio: "pipe",
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const output = redactText([result.stdout, result.stderr].filter(Boolean).join("\n"), token);
    throw new Error(`Failed to sync ${key}. Command: npx ${commandToString(args, token)}\n${output}`);
  }
}

function syncRequiredEnv({ prod, token, cliVersion, env, dryRun, projectRoot }) {
  const target = prod ? "production" : "preview";
  const localEnv = loadRequiredLocalEnv(projectRoot);

  console.log(`[deploy] syncing ${Object.keys(localEnv).length} env vars to ${target}`);
  for (const [key, value] of Object.entries(localEnv)) {
    syncVariable({ key, value, target, token, cliVersion, env, dryRun, projectRoot });
  }
}

function runStep(step, env, dryRun, token, projectRoot) {
  const stepEnv = { ...env, ...(step.envOverrides || {}) };

  if (dryRun) {
    if (step.disablesGitMetadata) {
      console.log(`[deploy] would run with Git metadata disabled via GIT_DIR=${stepEnv.GIT_DIR}`);
    }
    console.log(`[deploy] would run from ${step.cwd}: npx ${commandToString(step.args, token)}`);
    return;
  }

  if (step.disablesGitMetadata) {
    fs.mkdirSync(path.dirname(stepEnv.GIT_DIR), { recursive: true });
    fs.mkdirSync(stepEnv.GIT_WORK_TREE, { recursive: true });
    console.log(`[deploy] running with Git metadata disabled via GIT_DIR=${stepEnv.GIT_DIR}`);
  }

  console.log(`[deploy] ${step.label}`);
  const result = spawnSync("npx", step.args, {
    cwd: step.cwd,
    env: stepEnv,
    stdio: "pipe",
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const stdout = redactText(result.stdout, token);
  const stderr = redactText(result.stderr, token);
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }

  if (result.error) {
    throw new Error(`${step.label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${step.label} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = getProjectRoot(process.env);
  const deployGitDir = getDeployGitDir(process.env);
  const envInput = loadDeployEnv(projectRoot);
  const token = resolveToken(envInput);
  const projectLink = readProjectLink(projectRoot);
  const cliVersion = (envInput.VERCEL_CLI_VERSION || DEFAULT_VERCEL_CLI_VERSION).trim();

  const runtimeEnv = {
    ...envInput,
    ...loadRequiredLocalEnv(projectRoot),
    NPM_CONFIG_CACHE: envInput.NPM_CONFIG_CACHE || DEFAULT_NPM_CACHE,
    HOME: envInput.VERCEL_CLI_HOME || DEFAULT_VERCEL_HOME,
    UV_PYTHON_INSTALL_DIR: envInput.UV_PYTHON_INSTALL_DIR || DEFAULT_UV_PYTHON_INSTALL_DIR,
  };
  ensureLocalDirs(runtimeEnv);

  console.log(`[deploy] project=${projectLink.projectName || "unknown"}`);
  console.log(`[deploy] target=${options.prod ? "production" : "preview"}`);
  console.log(`[deploy] NPM_CONFIG_CACHE=${runtimeEnv.NPM_CONFIG_CACHE}`);
  console.log(`[deploy] HOME=${runtimeEnv.HOME}`);

  if (options.checkEnvOnly) {
    validateLocalBuildEnv(projectRoot);
    console.log("[deploy] environment check passed");
    return;
  }

  if (!options.skipEnvSync) {
    syncRequiredEnv({
      prod: options.prod,
      token,
      cliVersion,
      env: runtimeEnv,
      dryRun: options.dryRun,
      projectRoot,
    });
  }

  const steps = buildSteps({ prod: options.prod, token, cliVersion, projectRoot, deployGitDir });
  steps.forEach((step, index) => {
    runStep(step, runtimeEnv, options.dryRun, token, projectRoot);
    if (index === 0 && !options.dryRun) {
      validateLocalBuildEnv(projectRoot);
      console.log("[deploy] environment check passed");
    }
  });
}

try {
  main();
} catch (error) {
  console.error(`[deploy] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
