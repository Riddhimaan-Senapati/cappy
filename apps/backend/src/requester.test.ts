import { describe, expect, test } from "bun:test";
import { Profile, RequestBody, SnapshotOp } from "@browser-agent/shared";
import { stubRequester } from "./requester";

const profile = Profile.parse({ version: 0, summary: "", needs: [] });

function body(request: string, elements?: Array<{ id: string; tag: string; role?: string; text: string }>) {
  return RequestBody.parse({
    url: "https://example.com/watch",
    outline: { title: "Feed", headings: [], forms: 0, images: 0, videos: 0, canvases: 0, elements },
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
