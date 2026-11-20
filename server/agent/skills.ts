import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "skills");

export interface Skill {
  name: string;
  description: string;
  body: string;
}

// Read on every call so teammates can edit a playbook and try it without restarting the server.
export function loadSkills(): Skill[] {
  return readdirSync(SKILLS_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const text = readFileSync(path.join(SKILLS_DIR, file), "utf8");
      const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
      const meta = Object.fromEntries((match?.[1] ?? "").split("\n").map((line) => line.split(/:\s*(.*)/s).slice(0, 2).map((part) => part.trim())));
      return { name: meta.name ?? file.replace(/\.md$/, ""), description: meta.description ?? "", body: (match?.[2] ?? text).trim() };
    });
}

export function skillIndex(): string {
  return loadSkills()
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n");
}
