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

  it("declares python worker function settings for reclassify_job", () => {
    const projectRoot = path.resolve(__dirname, "../..");
    const vercelConfigPath = path.join(projectRoot, "vercel.json");

    expect(fs.existsSync(vercelConfigPath)).toBe(true);

    const vercelConfig = JSON.parse(fs.readFileSync(vercelConfigPath, "utf8"));
    const functions = vercelConfig.functions || {};

    expect(functions).toEqual(
      expect.objectContaining({
        "api/reclassify_job.py": expect.objectContaining({
          maxDuration: expect.any(Number),
        }),
      }),
    );
  });

  it("ships python dependencies required by the worker runtime", () => {
    const projectRoot = path.resolve(__dirname, "../..");
    const requirementsPath = path.join(projectRoot, "requirements.txt");

    expect(fs.existsSync(requirementsPath)).toBe(true);

    const requirements = fs.readFileSync(requirementsPath, "utf8");

    expect(requirements).toContain("pandas");
    expect(requirements).toContain("google-api-python-client");
  });
});
