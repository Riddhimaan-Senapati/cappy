import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const tsx = path.join(root, "node_modules", ".bin", "tsx");
const tests = ["gate", "injection", "replay"];

execFileSync("npm", ["run", "build:ext"], { cwd: root, stdio: "inherit" });

const failed: string[] = [];
for (const name of tests) {
  const result = spawnSync(tsx, [path.join(here, `${name}.ts`)], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, E2E_SKIP_BUILD: "1" },
  });
  if (result.status !== 0) failed.push(name);
}

console.log(`\ne2e: ${tests.length - failed.length} passed, ${failed.length} failed${failed.length ? ` (${failed.join(", ")})` : ""}`);
if (failed.length) process.exitCode = 1;
