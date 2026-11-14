import { blockCss, colorFilterSvg } from "@browser-agent/blocks";
import { applyContentFilters } from "./content-filter";
import { applyRuntimeBlocks } from "./runtime-blocks";
import type { PreferenceLayer } from "./preferences";

const PREFERENCE_SVG_ID = "adaptive-agent-preference-filters";

// Applies the saved-preference layer to a document and returns its own undo. It shares no handles with
// per-page changes or standing rules, so each can be removed without touching the others.
export type PreferenceLayerHandle = (() => void) & { refresh: () => void };

export function applyPreferenceLayer(layer: PreferenceLayer, doc: Document): PreferenceLayerHandle {
  const css = [...layer.blocks.map(blockCss), layer.css ?? ""].filter((part) => part.trim().length > 0).join("\n");

  let style: HTMLStyleElement | undefined;
  if (css.length > 0) {
    style = doc.createElement("style");
    style.setAttribute("data-ba", "preferences");
    style.textContent = css;
    doc.documentElement.append(style);
  }

  let svgHolder: HTMLElement | undefined;
  const colorFix = layer.blocks.find((b) => b.block === "color_fix");
  if (colorFix?.block === "color_fix") {
    svgHolder = doc.createElement("div");
    svgHolder.id = PREFERENCE_SVG_ID;
    svgHolder.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    const template = doc.createElement("template");
    template.innerHTML = colorFilterSvg(colorFix.mode);
    svgHolder.append(template.content);
    doc.body.append(svgHolder);
  }

  const undoRuntime = applyRuntimeBlocks(layer.blocks);
  const filters = layer.filters.length > 0 ? applyContentFilters(layer.filters, doc) : undefined;

  const undo = (() => {
    filters?.();
    undoRuntime();
    style?.remove();
    svgHolder?.remove();
  }) as PreferenceLayerHandle;
  undo.refresh = () => filters?.refresh();
  return undo;
}
