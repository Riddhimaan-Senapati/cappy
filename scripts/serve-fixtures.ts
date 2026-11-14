import { readdirSync } from "node:fs";
import { join } from "node:path";

const fixturesDir = join(import.meta.dir, "fixtures");
const port = Number(process.env.PORT ?? 5199);

Bun.serve({
  port,
  async fetch(req) {
    const name = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "");
    if (name === "") {
      const links = readdirSync(fixturesDir)
        .filter((f) => f.endsWith(".html"))
        .map((f) => `<li><a href="/${f}">${f}</a></li>`)
        .join("");
      return new Response(`<!doctype html><title>Demo pages</title><h1>Demo pages</h1><ul>${links}</ul>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (name.includes("/") || name.includes("..")) return new Response("not found", { status: 404 });
    const file = Bun.file(join(fixturesDir, name));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file);
  },
});

console.log(`demo pages on http://localhost:${port}/ (campus.html, form.html, ...)`);
