import { spawnSync } from "child_process";
import { existsSync } from "fs";
import path from "path";

const appRoot = path.resolve(__dirname, "..", "..");

describe("reclassification rule governance", () => {
  it("keeps generated Python and TypeScript rule registries current with the canonical YAML", () => {
    expect(existsSync(path.join(appRoot, "contracts", "reclass_rules.v1.yaml"))).toBe(true);
    expect(existsSync(path.join(appRoot, "scripts", "generate_reclass_rules.mjs"))).toBe(true);

    const result = spawnSync("node", ["scripts/generate_reclass_rules.mjs", "--check"], {
      cwd: appRoot,
      encoding: "utf8",
    });

    expect({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({
      status: 0,
      stdout: expect.stringContaining("generated reclassification rules are current"),
      stderr: "",
    });
  });
});
