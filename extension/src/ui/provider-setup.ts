import { save as saveSettings } from "../storage.js";
import type { BackgroundRequest, StatusInfo } from "../messages.js";
import { h } from "./dom.js";

const labels: Record<string, string> = {
  "chatgpt-signin": "ChatGPT",
  "anthropic-key": "Claude",
  "openai-key": "OpenAI API",
  gemini: "Gemini",
};

export function providerSetup() {
  const section = h("section", "s-sec", "", [h("h3", "", "Model provider")]);
  const form = h("form");
  const provider = h("select", "s-select");
  provider.setAttribute("aria-label", "Model provider");
  const key = h("input");
  key.type = "password";
  key.autocomplete = "off";
  key.placeholder = "API key";
  key.setAttribute("aria-label", "API key");
  const use = h("button", "s-btn", "Use provider");
  const save = h("button", "s-btn");
  save.type = "submit";
  use.type = "button";
  const status = h("p", "s-note");
  status.setAttribute("role", "status");
  form.append(h("div", "s-foot", "", [provider, use]), h("div", "s-foot", "", [key, save]));
  section.append(form, status);

  let current: StatusInfo | undefined;
  function update() {
    const selected = current?.providers?.find(({ id }) => id === provider.value);
    const signin = selected?.id === "chatgpt-signin";
    use.hidden = !selected?.ready || selected.id === current?.provider;
    key.hidden = signin;
    key.required = !signin;
    save.textContent = signin ? "Sign in with ChatGPT" : selected?.ready ? "Replace API key" : "Save API key";
  }

  async function refresh() {
    current = await chrome.runtime.sendMessage({ kind: "status" } satisfies BackgroundRequest);
    const selected = provider.value || current?.provider;
    provider.replaceChildren(...(current?.providers ?? []).map(({ id, ready }) => {
      const option = h("option", "", labels[id] ?? id);
      option.value = id;
      if (id === selected) option.selected = true;
      if (ready && id === current?.provider) option.textContent += " (active)";
      return option;
    }));
    form.hidden = !provider.options.length;
    update();
  }

  async function configure(action: "key" | "signin" | "select") {
    provider.disabled = key.disabled = use.disabled = save.disabled = true;
    status.textContent = action === "signin" ? "Complete ChatGPT sign-in in the browser tab that opens." : "Connecting…";
    try {
      const result = await chrome.runtime.sendMessage({
        kind: "providerSetup", provider: provider.value, action, ...(action === "key" ? { key: key.value } : {}),
      } satisfies BackgroundRequest);
      if (!result?.ok) throw new Error(result?.error ?? "Could not reach provider setup.");
      if (action === "key" && provider.value === "openai-key") {
        await saveSettings({ voiceProvider: "chrome", openAIVoiceVerified: false });
      }
      await refresh();
      status.textContent = `Using ${labels[provider.value]}.`;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Provider setup failed.";
    } finally {
      key.value = "";
      provider.disabled = key.disabled = use.disabled = save.disabled = false;
    }
  }

  provider.addEventListener("change", () => {
    key.value = "";
    update();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void configure(provider.value === "chatgpt-signin" ? "signin" : "key");
  });
  use.addEventListener("click", () => void configure("select"));
  form.hidden = true;
  void refresh().then(() => {
    if (form.hidden) {
      status.textContent = current?.connected ? "Provider setup requires the updated local server." : "Provider setup is paused while the local server is off.";
    }
  }).catch(() => { status.textContent = "Could not reach the local agent server."; });
  return section;
}
