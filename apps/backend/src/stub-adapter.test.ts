import { describe, expect, test } from "bun:test";
import { Adaptation, Need } from "@browser-agent/shared";
import { blocksFor, colorModeFor, stubAdapter } from "./stub-adapter";

function need(kind: Need["kind"], detail = "detail", id = `${kind}-id`): Need {
  return Need.parse({ id, kind, detail, source: "onboarding" });
}

describe("colorModeFor", () => {
  test("picks the simulation from the detail text", () => {
    expect(colorModeFor("Protan, red-green")).toBe("protanopia");
    expect(colorModeFor("tritanopia")).toBe("tritanopia");
    expect(colorModeFor("red-green colorblind")).toBe("deuteranopia");
  });
});

describe("blocksFor", () => {
  test("text_size becomes text_scale and focus keeps a text_focus block", () => {
    expect(blocksFor([need("text_size"), need("focus")])).toEqual([
      { block: "text_scale", scale: 1.3 },
      {
        block: "text_focus",
        fontScale: 1,
        lineHeight: 1.5,
        font: "system",
        hide: ["aside", "[role=complementary]"],
      },
    ]);
  });

  test("text_size alone scales text without a text_focus block", () => {
    expect(blocksFor([need("text_size")])).toEqual([{ block: "text_scale", scale: 1.3 }]);
  });

  test("motor produces a form_fixer block", () => {
    expect(blocksFor([need("motor")])).toEqual([
      { block: "form_fixer", addLabels: true, clearErrors: true, minTargetPx: 44, oneQuestionMode: false },
    ]);
  });

  test("light sensitivity produces a stop_motion block that pauses media", () => {
    expect(blocksFor([need("light_sensitivity")])).toEqual([{ block: "stop_motion", pauseMedia: true }]);
  });
});

describe("stubAdapter", () => {
  const url = "https://www.w3.org/Survey/";
  const outline = { title: "t", headings: [], forms: 0, images: 0, videos: 0, canvases: 0 };

  test("builds a valid adaptation citing the first need", async () => {
    const res = await stubAdapter({
      url,
      outline,
      profile: { version: 1, summary: "", needs: [need("text_size", "Prefers larger text", "n1")] },
    });
    expect(res.kind).toBe("adaptation");
    if (res.kind !== "adaptation") throw new Error("expected adaptation");
    expect(Adaptation.safeParse(res.adaptation).success).toBe(true);
    expect<string[]>(res.adaptation.sites).toEqual(["www.w3.org"]);
    expect<unknown>(res.adaptation.reason).toEqual({ text: "Prefers larger text", needId: "n1" });
  });

  test("returns none when the profile has no needs", async () => {
    const res = await stubAdapter({ url, outline, profile: { version: 0, summary: "", needs: [] } });
    expect(res).toEqual({ kind: "none", reason: "no needs in profile" });
  });
});
