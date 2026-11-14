import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const skill = readFileSync(new URL("../skills/install-browser-agent/SKILL.md", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const catalog = JSON.parse(readFileSync(new URL("../skills.sh.json", import.meta.url), "utf8")) as {
  groupings: Array<{ skills: string[] }>;
};

describe("install skill", () => {
  it("names itself in the frontmatter", () => {
    const frontmatter = skill.split("---")[1] ?? "";
    assert.match(frontmatter, /^name: install-browser-agent$/m);
    assert.match(frontmatter, /^description:/m);
  });

  it("is the skill the README tells an agent to fetch", () => {
    assert.match(readme, /skills\/install-browser-agent\/SKILL\.md/);
    assert.match(readme, /follow the instructions in its output to install and run browser-agent/);
  });

  it("is listed in the skills.sh catalog", () => {
    assert.deepEqual(catalog.groupings[0]?.skills, ["install-browser-agent"]);
  });
});
