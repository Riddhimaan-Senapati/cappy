import { describe, expect, test } from "bun:test";
import { Profile, RequestBody, SnapshotOp } from "@browser-agent/shared";
import { stubRequester } from "./requester";

const profile = Profile.parse({ version: 0, summary: "", needs: [] });

type Group = { selector: string; count: number; samples: string[] };

function body(
  request: string,
  elements?: Array<{ id: string; tag: string; role?: string; text: string }>,
  groups?: Group[],
) {
  return RequestBody.parse({
    url: "https://example.com/watch",
    outline: { title: "Feed", headings: [], forms: 0, images: 0, videos: 0, canvases: 0, elements, groups },
    profile,
    request,
  });
}

describe("stub requester", () => {
  test("invert asks for css and no blocks", async () => {
    const res = await stubRequester(body("invert this page"));
    expect(res.kind).toBe("adaptation");
    if (res.kind !== "adaptation") return;
    expect(res.adaptation.blocks).toEqual([]);
    expect(res.adaptation.css).toContain("invert(1)");
    expect(res.adaptation.ops).toBeUndefined();
  });

  test("hide the sidebar hides the aside and recommendation elements by id", async () => {
    const res = await stubRequester(
      body("hide the sidebar", [
        { id: "n1", tag: "main", text: "Videos" },
        { id: "n2", tag: "aside", text: "Recommended" },
        { id: "n3", tag: "div", role: "complementary", text: "More" },
      ]),
    );
    expect(res.kind).toBe("adaptation");
    if (res.kind !== "adaptation") return;
    expect(res.adaptation.ops).toEqual(SnapshotOp.array().parse([{ op: "hide", ids: ["n2", "n3"] }]));
  });

  test("hide the sidebar with no matching element answers none", async () => {
    const res = await stubRequester(body("hide the sidebar", [{ id: "n1", tag: "main", text: "Videos" }]));
    expect(res.kind).toBe("none");
  });
});

const FEED: Group[] = [
  { selector: "ytd-rich-item-renderer", count: 24, samples: ["Lex Fridman Podcast #400", "How to cook pasta", "Huberman Lab Podcast"] },
  { selector: "ytd-rich-section-renderer", count: 1, samples: ["Podcasts"] },
  { selector: "ytd-guide-entry-renderer", count: 9, samples: ["Home", "Shorts"] },
];

describe("stub requester content filters", () => {
  test("remove all podcasts hides the largest group whose samples mention podcast", async () => {
    const res = await stubRequester(body("remove all podcasts", undefined, FEED));
    expect(res.kind).toBe("adaptation");
    if (res.kind !== "adaptation") return;
    expect(res.adaptation.blocks).toEqual([]);
    expect(res.adaptation.filters).toEqual([
      { itemSelector: "ytd-rich-item-renderer", keywords: ["podcasts", "podcast"], action: "hide" },
    ]);
  });

  test("dim uses the dim action", async () => {
    const res = await stubRequester(body("hide crypto posts", undefined, FEED));
    expect(res.kind === "adaptation" && res.adaptation.filters?.[0]?.action).toBe("hide");
    const dim = await stubRequester(body("dim podcasts", undefined, FEED));
    expect(dim.kind === "adaptation" && dim.adaptation.filters?.[0]?.action).toBe("dim");
  });

  test("a group whose samples mention the keyword wins even when it is smaller", async () => {
    const res = await stubRequester(body("hide shorts", undefined, FEED));
    expect(res.kind === "adaptation" && res.adaptation.filters).toEqual([
      { itemSelector: "ytd-guide-entry-renderer", keywords: ["shorts", "short"], action: "hide" },
    ]);
  });

  test("with no keyword match the largest group is used", async () => {
    const res = await stubRequester(body("hide crypto", undefined, FEED));
    expect(res.kind === "adaptation" && res.adaptation.filters).toEqual([
      { itemSelector: "ytd-rich-item-renderer", keywords: ["crypto", "cryptos"], action: "hide" },
    ]);
  });

  test("no groups answers none with a reason", async () => {
    const res = await stubRequester(body("remove all podcasts"));
    expect(res.kind).toBe("none");
    expect(res.kind === "none" && res.reason.length > 0).toBe(true);
  });

  test("the sidebar and invert requests keep their old routes", async () => {
    const hide = await stubRequester(body("hide the sidebar", [{ id: "n2", tag: "aside", text: "Recommended" }], FEED));
    expect(hide.kind === "adaptation" && hide.adaptation.ops).toBeDefined();
    const invert = await stubRequester(body("invert this page", undefined, FEED));
    expect(invert.kind === "adaptation" && invert.adaptation.css).toContain("invert(1)");
  });
});
