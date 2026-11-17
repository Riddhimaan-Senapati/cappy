import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const runner = process.execPath;
const tests = ["site-controls", "gate", "injection", "replay", "replay-trap", "form", "verification", "preferences", "history", "options", "voice-point", "profiles", "schedule", "bar-enter", "saved-changes", "page-load", "ask-first", "dark-replay", "request-counts", "voice-live", "welcome-focus"];

execFileSync("bun", ["run", "build:ext"], { cwd: root, stdio: "inherit" });

const failed: string[] = [];
for (const name of tests) {
  const result = spawnSync(runner, [path.join(here, `${name}.ts`)], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, E2E_SKIP_BUILD: "1" },
  });
  if (result.status !== 0) failed.push(name);
}

console.log(`\ne2e: ${tests.length - failed.length} passed, ${failed.length} failed${failed.length ? ` (${failed.join(", ")})` : ""}`);
if (failed.length) process.exitCode = 1;
