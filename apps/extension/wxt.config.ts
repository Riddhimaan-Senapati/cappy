import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Adaptive Browser Agent",
    description: "Adapts websites to your accessibility needs, with an undo for every change.",
    permissions: ["storage", "scripting", "sidePanel", "tabs", "activeTab"],
    host_permissions: ["<all_urls>"],
    side_panel: { default_path: "sidepanel.html" },
    action: { default_title: "Open Adaptive Browser Agent" },
    // MediaPipe's HandLandmarker runs its WASM inside the side panel page.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
  },
});
