import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const projectRoot = path.resolve(__dirname, "../..");
const scriptPath = path.join(projectRoot, "scripts/vercel_env_sync.mjs");

const requiredEnv = {
  NEXTAUTH_URL: "https://audit.frankzh.top",
  NEXTAUTH_SECRET: "secret",
  NEXT_PUBLIC_SUPABASE_URL: "https://supabase.example.com",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_CLIENT_EMAIL: "service@example.com",
  GOOGLE_PRIVATE_KEY: "private-key",
  GOOGLE_SHEET_ID: "sheet-id",
  GOOGLE_SHEET_TEMPLATE_ID: "template-id",
  AIWB_WORKER_SECRET: "worker-secret",
  EXTERNAL_IMPORT_WORKER_URL: "https://worker.example.com/api/external-import",
  EXTERNAL_IMPORT_WORKER_SECRET: "external-import-secret",
  VERCEL_AUTOMATION_BYPASS_SECRET: "vercel-bypass-secret",
};

function makeTempProject(env: Record<string, string>) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-env-sync-"));
  fs.mkdirSync(path.join(tempRoot, ".vercel"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, ".vercel", "project.json"),
    JSON.stringify({ projectName: "excel-master-app", projectId: "prj_test", orgId: "team_test" }),
  );
  fs.writeFileSync(
    path.join(tempRoot, ".env.local"),
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );
  return tempRoot;
}

function runSync(tempRoot: string, extraEnv: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [scriptPath, "--prod", "--dry-run"], {
    cwd: tempRoot,
    env: {
      NODE_ENV: "test",
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      AIWB_DEPLOY_PROJECT_ROOT: tempRoot,
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

describe("vercel env sync script", () => {
  it("dry-runs all required production variables without printing secret values", () => {
    const tempRoot = makeTempProject(requiredEnv);
    const result = runSync(tempRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("project=excel-master-app");
    expect(result.stdout).toContain("target=production");
    expect(result.stdout).toContain("variables=15");
    expect(result.stdout).toContain("would sync NEXTAUTH_URL to production");
    expect(result.stdout).toContain("would sync GOOGLE_SHEET_TEMPLATE_ID to production");
    expect(result.stdout).toContain("would sync AIWB_WORKER_SECRET to production");
    expect(result.stdout).toContain("would sync EXTERNAL_IMPORT_WORKER_SECRET to production");
    expect(result.stdout).toContain("would sync VERCEL_AUTOMATION_BYPASS_SECRET to production");
    expect(result.stdout).not.toContain("service");
    expect(result.stdout).not.toContain("private-key");
    expect(result.stdout).not.toContain("worker-secret");
    expect(result.stdout).not.toContain("external-import-secret");
    expect(result.stdout).not.toContain("vercel-bypass-secret");
  });

  it("fails before syncing when a required local variable is missing", () => {
    const { GOOGLE_SHEET_TEMPLATE_ID, ...missingTemplateId } = requiredEnv;
    const tempRoot = makeTempProject(missingTemplateId);
    const result = runSync(tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid local environment");
    expect(result.stderr).toContain("GOOGLE_SHEET_TEMPLATE_ID is missing");
  });

  it("does not require the optional Vercel automation bypass secret", () => {
    const { VERCEL_AUTOMATION_BYPASS_SECRET, ...withoutBypass } = requiredEnv;
    const tempRoot = makeTempProject(withoutBypass);
    const result = runSync(tempRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("variables=14");
    expect(result.stdout).not.toContain("would sync VERCEL_AUTOMATION_BYPASS_SECRET to production");
  });
});
