import { describe, expect, test } from "bun:test";
import { Profile, RequestBody, SnapshotOp } from "@browser-agent/shared";
import { buildRequestPrompt, clockRangeFor, scheduleFor, stubRequester } from "./requester";

const profile = Profile.parse({ version: 0, summary: "", needs: [] });

type Group = { selector: string; count: number; samples: string[]; label?: string };

const NOV_14 = { iso: "2026-11-14T10:00:00-05:00", timeZone: "America/New_York" };

function body(
  request: string,
  elements?: Array<{ id: string; tag: string; role?: string; text: string }>,
  groups?: Group[],
  clientTime: { iso: string; timeZone: string } | undefined = NOV_14,
) {
  return RequestBody.parse({
    url: "https://example.com/watch",
    outline: { title: "Feed", headings: [], forms: 0, images: 0, videos: 0, canvases: 0, elements, groups },
    profile,
    request,
    clientTime,
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

  test("with no group mentioning the keyword the filter omits itemSelector", async () => {
    const res = await stubRequester(body("hide crypto", undefined, FEED));
    expect(res.kind === "adaptation" && res.adaptation.filters).toEqual([
      { keywords: ["crypto", "cryptos"], action: "hide" },
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

describe("stub requester schedules", () => {
  const filterOf = async (request: string, clientTime = NOV_14) => {
    const res = await stubRequester(body(request, undefined, FEED, clientTime));
    return res.kind === "adaptation" ? res.adaptation.filters?.[0] : undefined;
  };

  test("a clock range with weekdays becomes a 9 to 5 weekday schedule", async () => {
    expect(await filterOf("hide podcasts 9 to 5 on weekdays")).toEqual({
      itemSelector: "ytd-rich-item-renderer",
      keywords: ["podcasts", "podcast"],
      action: "hide",
      schedule: { start: "09:00", end: "17:00", days: ["mon", "tue", "wed", "thu", "fri"] },
    });
  });

  test("clock ranges with am and pm and minutes", () => {
    expect(clockRangeFor("9:00 am to 5:00 pm")).toEqual({ start: "09:00", end: "17:00" });
    expect(clockRangeFor("9 - 5")).toEqual({ start: "09:00", end: "17:00" });
    expect(clockRangeFor("10 pm to 6 am")).toEqual({ start: "22:00", end: "06:00" });
    expect(clockRangeFor("hide posts about 2026-11-05")).toBeUndefined();
  });

  test("weekends becomes sat and sun", async () => {
    const f = await filterOf("hide sports on weekends");
    expect(f?.schedule).toEqual({ days: ["sat", "sun"] });
  });

  test("until a date without a year uses clientTime's year", async () => {
    const f = await filterOf("hide reels until December 15");
    expect(f?.schedule).toEqual({ until: "2026-12-15" });
  });

  test("until a date that already passed rolls to next year", async () => {
    const f = await filterOf("hide reels until October 3");
    expect(f?.schedule).toEqual({ until: "2027-10-03" });
  });

  test("from and to dates become an inclusive range", async () => {
    const f = await filterOf("hide sports news from Nov 20 to Dec 5");
    expect(f?.keywords).toEqual(["sports", "sport"]);
    expect(f?.schedule).toEqual({ from: "2026-11-20", until: "2026-12-05" });
  });

  test("a range that crosses the new year ends in the next year", async () => {
    const f = await filterOf("hide sports news from Dec 20 to Jan 5", { iso: "2026-12-01T09:00:00Z", timeZone: "UTC" });
    expect(f?.schedule).toEqual({ from: "2026-12-20", until: "2027-01-05" });
  });

  test("everywhere or on every site sets everywhere", async () => {
    expect((await filterOf("remove promoted posts everywhere"))?.everywhere).toBe(true);
    expect((await filterOf("hide promoted posts on every site"))?.everywhere).toBe(true);
    expect((await filterOf("hide podcasts 9 to 5"))?.everywhere).toBeUndefined();
  });

  test("a promoted-posts rule with no matching group keeps the keyword and drops the selector", async () => {
    const res = await stubRequester(body("remove promoted posts everywhere", undefined, FEED));
    expect(res.kind === "adaptation" && res.adaptation.filters).toEqual([
      { keywords: ["promoted", "promoteds"], action: "hide", everywhere: true },
    ]);
  });

  test("without clientTime the year comes from the server clock", async () => {
    const f = await stubRequester(body("hide shorts until December 15", undefined, FEED, undefined));
    const until = f.kind === "adaptation" ? f.adaptation.filters?.[0]?.schedule?.until : undefined;
    expect(until).toMatch(/^\d{4}-12-15$/);
    expect(Number(until?.slice(0, 4))).toBeGreaterThanOrEqual(new Date().getFullYear());
  });

  test("an impossible date is ignored", () => {
    expect(scheduleFor("until February 30", NOV_14)).toBeUndefined();
  });
});

describe("request prompt", () => {
  test("client time, labelled groups and schedule rules are in the prompt", () => {
    const prompt = buildRequestPrompt(
      body("hide podcasts 9 to 5 on weekdays", undefined, [
        { selector: "ytd-rich-item-renderer", count: 24, samples: ["Huberman Lab Podcast"] },
      ]),
    );
    expect(prompt).toContain("Current local time: 2026-11-14T10:00:00-05:00 (America/New_York)");
    expect(prompt).toContain("For time-limited requests set filter.schedule");
    expect(prompt).toContain("Set everywhere: true only if the user says everywhere / on every site.");
    expect(prompt).toContain("you may omit itemSelector");
    expect(prompt).toContain('ytd-rich-item-renderer ×24: "Huberman Lab Podcast"');
  });

  test("group labels appear in brackets", () => {
    const prompt = buildRequestPrompt(
      body("hide reels", [{ id: "n1", tag: "a", text: "Reel" }], [
        { selector: 'a[href*="/reel/"]', count: 12, samples: ["Reel"], label: "Reel" },
      ]),
    );
    expect(prompt).toContain('a[href*="/reel/"] ×12 [Reel]: "Reel"');
  });

  test("a retry note is repeated as a reason to choose again", () => {
    const retry = RequestBody.parse({
      url: "https://example.com/watch",
      outline: { title: "Feed", headings: [], forms: 0, images: 0, videos: 0, canvases: 0 },
      profile,
      request: "hide podcasts",
      retryNote: "no item matched the word podcast",
    });
    expect(buildRequestPrompt(retry)).toContain(
      "Your previous filter matched nothing on this page: no item matched the word podcast. Choose a different group or keywords.",
    );
    expect(buildRequestPrompt(body("hide podcasts"))).not.toContain("Your previous filter matched nothing");
  });
});

test("stub filter never targets a bare generic tag and prefers specific groups", async () => {
  const body: any = {
    url: "https://www.youtube.com/",
    outline: {
      title: "YouTube", headings: [], forms: 0, images: 0, videos: 0, canvases: 0,
      groups: [
        { selector: "div", count: 31, samples: ["Podcasts", "Lex Fridman Podcast", "cooking"] },
        { selector: "ytd-rich-item-renderer", count: 24, samples: ["Huberman Lab Podcast", "pasta", "news"] },
      ],
    },
    profile: { version: 0, summary: "", needs: [] },
    request: "remove all podcasts",
  };
  const res = await stubRequester(body);
  expect(res.kind).toBe("adaptation");
  if (res.kind === "adaptation") expect(res.adaptation.filters?.[0]?.itemSelector).toBe("ytd-rich-item-renderer");
});

test("dark mode requests use the native-first dark_mode block, invert stays css", async () => {
  const base: any = { url: "https://example.com/", outline: { title: "x", headings: [], forms: 0, images: 0, videos: 0, canvases: 0 }, profile: { version: 0, summary: "", needs: [] } };
  const dark = await stubRequester({ ...base, request: "turn on dark mode" });
  expect(dark.kind === "adaptation" && dark.adaptation.blocks).toEqual([{ block: "dark_mode", allowSiteControls: true }]);
  const invert = await stubRequester({ ...base, request: "invert this page" });
  expect(invert.kind === "adaptation" && invert.adaptation.css).toContain("invert");
});
