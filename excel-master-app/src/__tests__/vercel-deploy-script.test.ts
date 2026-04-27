import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const projectRoot = path.resolve(__dirname, "../..");
const scriptPath = path.join(projectRoot, "scripts/vercel_deploy.mjs");

function runDeployScript(env: NodeJS.ProcessEnv, args = ["--prod", "--dry-run"]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: env.AIWB_DEPLOY_PROJECT_ROOT || projectRoot,
    env: {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      ...env,
    },
    encoding: "utf8",
  });
}

describe("vercel deploy script", () => {
  it("rejects VERCEL_OIDC_TOKEN as a replacement for the CLI access token", () => {
    const result = runDeployScript({
      VERCEL_TOKEN: "",
      VERCEL_OIDC_TOKEN: "oidc-token-from-vercel-runtime",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("VERCEL_TOKEN is required");
    expect(result.stderr).toContain("VERCEL_OIDC_TOKEN is not a Vercel CLI access token");
  });

  it("prints a redacted production pull/deploy plan in dry-run mode", () => {
    const result = runDeployScript({
      VERCEL_TOKEN: "vcp_test_token_for_dry_run_only",
      VERCEL_OIDC_TOKEN: "",
      AIWB_DEPLOY_GIT_DIR: "/tmp/aiwb-vercel-git-disabled-test",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("syncing 11 required env vars to production");
    expect(result.stdout).toContain("would sync NEXTAUTH_URL to production");
    expect(result.stdout).toContain("would sync GOOGLE_SHEET_TEMPLATE_ID to production");
    expect(result.stdout).toContain("vercel@52.0.0 pull --yes --environment=production --token <redacted>");
    expect(result.stdout).toContain("vercel@52.0.0 deploy --archive=tgz --prod --yes --token <redacted>");
    expect(result.stdout).not.toContain("--prebuilt");
    expect(result.stdout).toContain("with Git metadata disabled");
    expect(result.stdout).toContain("NPM_CONFIG_CACHE=/tmp/npm-cache");
    expect(result.stdout).not.toContain("vcp_test_token_for_dry_run_only");
  });

  it("runs the source deploy from the project root with git metadata disabled", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-deploy-gitless-"));
    const tempBin = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-deploy-bin-"));
    fs.mkdirSync(path.join(tempRoot, ".vercel", "output"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, ".vercel", "project.json"),
      JSON.stringify({ projectName: "excel-master-app", projectId: "prj_test", orgId: "team_test" }),
    );
    fs.writeFileSync(path.join(tempRoot, ".vercel", "output", "config.json"), "{}");
    fs.writeFileSync(
      path.join(tempRoot, ".env.local"),
      [
        "NEXTAUTH_URL=https://audit.frankzh.top",
        "NEXTAUTH_SECRET=secret",
        "NEXT_PUBLIC_SUPABASE_URL=https://supabase.example.com",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY=anon",
        "SUPABASE_SERVICE_ROLE_KEY=service",
        "GOOGLE_CLIENT_ID=client-id",
        "GOOGLE_CLIENT_SECRET=client-secret",
        "GOOGLE_CLIENT_EMAIL=service@example.com",
        "GOOGLE_PRIVATE_KEY=private-key",
        "GOOGLE_SHEET_ID=sheet-id",
        "GOOGLE_SHEET_TEMPLATE_ID=template-id",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(tempBin, "npx"),
      [
        "#!/bin/sh",
        "case \"$*\" in",
        "  *' deploy '*) echo \"deploy pwd=$PWD git_dir=$GIT_DIR git_work_tree=$GIT_WORK_TREE\" ;;",
        "esac",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = runDeployScript(
      {
        AIWB_DEPLOY_PROJECT_ROOT: tempRoot,
        AIWB_DEPLOY_GIT_DIR: "/tmp/aiwb-vercel-git-disabled-test",
        PATH: `${tempBin}:${process.env.PATH || ""}`,
        VERCEL_TOKEN: "vcp_test_token_for_gitless_deploy",
      },
      ["--prod", "--skip-env-sync"],
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`deploy pwd=${fs.realpathSync(tempRoot)}`);
    expect(result.stdout).toContain("git_dir=/tmp/aiwb-vercel-git-disabled-test/.git");
    expect(result.stdout).toContain("git_work_tree=/tmp/aiwb-vercel-git-disabled-test/work-tree");
  });

  it("redacts the token from child process output and errors", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-deploy-redact-"));
    const tempBin = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-deploy-bin-"));
    const token = "vcp_secret_token_that_must_not_leak";
    fs.mkdirSync(path.join(tempRoot, ".vercel"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, ".vercel", "project.json"),
      JSON.stringify({ projectName: "excel-master-app", projectId: "prj_test", orgId: "team_test" }),
    );
    fs.writeFileSync(
      path.join(tempRoot, ".env.local"),
      [
        "NEXTAUTH_URL=https://audit.frankzh.top",
        "NEXTAUTH_SECRET=secret",
        "NEXT_PUBLIC_SUPABASE_URL=https://supabase.example.com",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY=anon",
        "SUPABASE_SERVICE_ROLE_KEY=service",
        "GOOGLE_CLIENT_ID=client-id",
        "GOOGLE_CLIENT_SECRET=client-secret",
        "GOOGLE_CLIENT_EMAIL=service@example.com",
        "GOOGLE_PRIVATE_KEY=private-key",
        "GOOGLE_SHEET_ID=sheet-id",
        "GOOGLE_SHEET_TEMPLATE_ID=template-id",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(tempBin, "npx"),
      [
        "#!/bin/sh",
        `echo "stdout leaked ${token}"`,
        `echo "stderr leaked ${token}" >&2`,
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = runDeployScript(
      {
        AIWB_DEPLOY_PROJECT_ROOT: tempRoot,
        PATH: `${tempBin}:${process.env.PATH || ""}`,
        VERCEL_TOKEN: token,
      },
      ["--prod", "--skip-env-sync"],
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("stdout leaked <redacted>");
    expect(result.stderr).toContain("stderr leaked <redacted>");
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
  });

  it("fails env checks before build when local production build variables are empty", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-deploy-env-"));
    fs.mkdirSync(path.join(tempRoot, ".vercel"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, ".vercel", "project.json"),
      JSON.stringify({ projectName: "excel-master-app", projectId: "prj_test", orgId: "team_test" }),
    );
    fs.writeFileSync(
      path.join(tempRoot, ".env.local"),
      [
        "NEXTAUTH_URL=https://audit.frankzh.top",
        "NEXTAUTH_SECRET=secret",
        "NEXT_PUBLIC_SUPABASE_URL=",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY=anon",
        "SUPABASE_SERVICE_ROLE_KEY=service",
        "GOOGLE_CLIENT_ID=client-id",
        "GOOGLE_CLIENT_SECRET=client-secret",
        "GOOGLE_CLIENT_EMAIL=service@example.com",
        "GOOGLE_PRIVATE_KEY=private-key",
        "GOOGLE_SHEET_ID=sheet-id",
        "GOOGLE_SHEET_TEMPLATE_ID=template-id",
      ].join("\n"),
    );

    const result = runDeployScript(
      {
        AIWB_DEPLOY_PROJECT_ROOT: tempRoot,
        VERCEL_TOKEN: "vcp_test_token_for_dry_run_only",
      },
      ["--prod", "--check-env-only"],
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid local environment");
    expect(result.stderr).toContain("NEXT_PUBLIC_SUPABASE_URL is empty");
  });

  it("passes env checks from local env even when pulled sensitive production values are blank", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-deploy-env-"));
    fs.mkdirSync(path.join(tempRoot, ".vercel"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, ".vercel", "project.json"),
      JSON.stringify({ projectName: "excel-master-app", projectId: "prj_test", orgId: "team_test" }),
    );
    const validLocalEnv = [
      "NEXTAUTH_URL=https://audit.frankzh.top",
      "NEXTAUTH_SECRET=secret",
      "NEXT_PUBLIC_SUPABASE_URL=https://supabase.example.com",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY=anon",
      "SUPABASE_SERVICE_ROLE_KEY=service",
      "GOOGLE_CLIENT_ID=client-id",
      "GOOGLE_CLIENT_SECRET=client-secret",
      "GOOGLE_CLIENT_EMAIL=service@example.com",
      "GOOGLE_PRIVATE_KEY=private-key",
      "GOOGLE_SHEET_ID=sheet-id",
      "GOOGLE_SHEET_TEMPLATE_ID=template-id",
    ].join("\n");
    fs.writeFileSync(path.join(tempRoot, ".env.local"), validLocalEnv);
    fs.writeFileSync(
      path.join(tempRoot, ".vercel", ".env.production.local"),
      [
        "NEXTAUTH_URL=",
        "NEXTAUTH_SECRET=",
        "NEXT_PUBLIC_SUPABASE_URL=",
      ].join("\n"),
    );

    const result = runDeployScript(
      {
        AIWB_DEPLOY_PROJECT_ROOT: tempRoot,
        VERCEL_TOKEN: "vcp_test_token_for_dry_run_only",
      },
      ["--prod", "--check-env-only"],
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("environment check passed");
  });
});
