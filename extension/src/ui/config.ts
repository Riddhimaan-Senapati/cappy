import { exportConfig, importConfig, parseConfig, type ImportedConfig } from "../config.js";
import { h } from "./dom.js";

export function createConfigView(rerender: () => void) {
  let pending: ImportedConfig | null = null;
  let message = "";
  let error = false;
  let busy = false;

  const run = async (action: () => Promise<void>) => {
    busy = true;
    error = false;
    message = "";
    rerender();
    try {
      await action();
    } catch (cause) {
      error = true;
      message = cause instanceof Error ? cause.message : "Could not transfer config.";
    } finally {
      busy = false;
      rerender();
    }
  };

  return () => {
    const button = (label: string, action: () => void) => {
      const el = h("button", "s-btn", label);
      el.type = "button";
      el.disabled = busy;
      el.addEventListener("click", action);
      return el;
    };
    const file = h("input");
    file.type = "file";
    file.accept = ".json,application/json";
    file.hidden = true;
    file.setAttribute("aria-label", "Import config file");
    file.addEventListener("change", () => {
      const selected = file.files?.[0];
      if (!selected) return;
      pending = null;
      void run(async () => { pending = parseConfig(await selected.text()); });
    });
    const exportButton = button("Export config", () => void run(async () => {
      const url = URL.createObjectURL(new Blob([await exportConfig()], { type: "application/json" }));
      const link = h("a");
      link.href = url;
      link.download = `browser-agent-config-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      message = "Config exported.";
    }));
    const status = h("div", `s-note${error ? " s-error" : ""}`, message);
    status.setAttribute("role", "status");
    return h("section", "s-sec", "", [
      h("h3", "", "Import and export"),
      h("div", "s-note", "Move all profiles, preferences, saved changes, commands, and request history to another computer using a JSON file. The file includes personal saved data. API keys, sign-ins, and the server address stay on each computer. Verify AI audio again after importing."),
      file,
      h("div", "s-acts", "", [exportButton, button("Import config", () => file.click())]),
      ...(pending ? [
        h("div", "s-note", `Import ${Object.keys(pending.profiles).length} profile(s)? This replaces your current profiles and preferences.`),
        h("div", "s-acts", "", [
          button("Replace config", () => void run(async () => {
            await importConfig(pending!);
            pending = null;
            message = "Config imported. Open websites now use your imported settings.";
          })),
          button("Cancel", () => { pending = null; rerender(); }),
        ]),
      ] : []),
      status,
    ]);
  };
}
