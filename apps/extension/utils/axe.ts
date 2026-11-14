import axe from "axe-core";

export async function countViolations(): Promise<number> {
  const results = await axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
  });
  return results.violations.reduce((sum, violation) => sum + violation.nodes.length, 0);
}
