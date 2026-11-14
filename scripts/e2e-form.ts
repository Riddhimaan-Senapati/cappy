import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import {
  BACKEND_PORT,
  assert,
  launchWithExtension,
  seedProfile,
  serveFixtures,
  startBackend,
} from "./lib-e2e";

const PAGE_PORT = 5182;

const userDataDir = mkdtempSync(join(tmpdir(), "ba-e2e-"));
let backend: Bun.Subprocess | undefined;
let page: Bun.Server | undefined;
let context: BrowserContext | undefined;

try {
  backend = await startBackend({ port: BACKEND_PORT, env: { GEMINI_API_KEY: "" } });
  page = serveFixtures(PAGE_PORT);
  context = await launchWithExtension(userDataDir);

  await seedProfile(context, {
    version: 1,
    summary: "Uses a keyboard and has limited fine motor control.",
    needs: [{ id: "n1", kind: "motor", detail: "limited fine motor control", source: "onboarding" }],
  });

  const tab = await context.newPage();
  await tab.goto(`http://localhost:${PAGE_PORT}/form.html`);

  await tab
    .waitForFunction(
      () => {
        const inputs = Array.from(document.querySelectorAll("input"));
        return (
          inputs.length > 0 &&
          inputs.every((input) => input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`))
        );
      },
      null,
      { timeout: 10_000 },
    )
    .catch(() => {
      throw new Error("FAIL: not every input got a label[for] within 10s");
    });
  console.log("ok: every input has an accessible name (label[for]) within 10s");

  const positiveTabindex = await tab.evaluate(
    () => Array.from(document.querySelectorAll("[tabindex]")).filter((el) => Number(el.getAttribute("tabindex")) > 0).length,
  );
  assert(positiveTabindex === 0, "positive tabindex values were removed");

  console.log("FORM PASSED");
} finally {
  await context?.close();
  page?.stop(true);
  backend?.kill();
  rmSync(userDataDir, { recursive: true, force: true });
}
