import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SnapshotId, type SnapshotOp } from "@browser-agent/shared";
import { applyOps } from "./apply-ops";

beforeAll(() => {
  if (!globalThis.document) GlobalRegistrator.register();
});

beforeEach(() => {
  document.body.innerHTML = "";
});

const id = (n: number) => SnapshotId.parse(`n${n}`);

function mapOf(...els: Element[]): Map<string, Element> {
  return new Map(els.map((el, i) => [`n${i + 1}`, el]));
}

describe("applyOps", () => {
  test("hide sets display none with important priority", () => {
    document.body.innerHTML = `<aside id="side">Recommended</aside>`;
    const aside = document.getElementById("side") as HTMLElement;
    applyOps([{ op: "hide", ids: [id(1)] }], mapOf(aside));
    expect(getComputedStyle(aside).display).toBe("none");
    expect(aside.style.getPropertyPriority("display")).toBe("important");
  });

  test("style sets only allowlisted properties as important", () => {
    document.body.innerHTML = `<p id="p">Text</p>`;
    const p = document.getElementById("p") as HTMLElement;
    const ops: SnapshotOp[] = [
      { op: "style", ids: [id(1)], styles: { color: "rgb(255, 255, 255)", "font-size": "24px" } },
    ];
    applyOps(ops, mapOf(p));
    expect(p.style.getPropertyValue("color")).toBe("rgb(255, 255, 255)");
    expect(p.style.getPropertyPriority("color")).toBe("important");
    expect(p.style.getPropertyValue("font-size")).toBe("24px");
  });

  test("ids missing from the map are skipped", () => {
    document.body.innerHTML = `<p id="p">Text</p>`;
    const p = document.getElementById("p") as HTMLElement;
    const undo = applyOps([{ op: "hide", ids: [id(1), id(9)] }], mapOf(p));
    expect(p.style.display).toBe("none");
    undo();
    expect(p.getAttribute("style")).toBeNull();
  });

  test("apply then undo restores the original style attribute exactly", () => {
    const original = "color: red;  margin:0 ;";
    document.body.innerHTML = `<div id="d" style="${original}"><button id="b">Go</button></div>`;
    const d = document.getElementById("d") as HTMLElement;
    const b = document.getElementById("b") as HTMLElement;
    const before = document.body.innerHTML;

    const undo = applyOps(
      [
        { op: "hide", ids: [id(1)] },
        { op: "style", ids: [id(1), id(2)], styles: { color: "blue", padding: "4px" } },
      ],
      mapOf(d, b),
    );
    expect(d.style.display).toBe("none");
    expect(d.getAttribute("style")).not.toBe(original);

    undo();
    expect(d.getAttribute("style")).toBe(original);
    expect(b.getAttribute("style")).toBeNull();
    expect(document.body.innerHTML).toBe(before);
  });

  test("undo removes the style attribute when the element had none", () => {
    document.body.innerHTML = `<p id="p">Text</p>`;
    const p = document.getElementById("p") as HTMLElement;
    const undo = applyOps([{ op: "style", ids: [id(1)], styles: { opacity: "0.5" } }], mapOf(p));
    undo();
    expect(p.hasAttribute("style")).toBe(false);
  });

  test("undo is safe to call twice", () => {
    document.body.innerHTML = `<p id="p" style="color: red">Text</p>`;
    const p = document.getElementById("p") as HTMLElement;
    const undo = applyOps([{ op: "hide", ids: [id(1)] }], mapOf(p));
    undo();
    p.setAttribute("style", "color: green");
    undo();
    expect(p.getAttribute("style")).toBe("color: green");
  });
});
