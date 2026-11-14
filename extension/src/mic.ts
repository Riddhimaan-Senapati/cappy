const CSS = `
html, body { margin: 0; min-height: 100%; background: #121217; color: #f4f4f7; font: 15px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 440px; margin: 0 auto; padding: 64px 16px; display: flex; flex-direction: column; gap: 16px; }
h1 { margin: 0; font-size: 22px; letter-spacing: -0.01em; }
p { margin: 0; color: #a1a1af; }
button { align-self: flex-start; padding: 10px 18px; border: 0; border-radius: 12px; background: linear-gradient(135deg, #6ea8ff 0%, #a78bfa 55%, #f472b6 100%); color: #0d0d12; font: inherit; font-weight: 650; cursor: pointer; }
button:focus-visible { outline: 2px solid #8b9bff; outline-offset: 3px; }
button:disabled { opacity: 0.6; cursor: default; }
#status { color: #f4f4f7; min-height: 1.5em; }
#status.bad { color: #f87171; }
#status.good { color: #4ade80; }
`;

const app = document.getElementById("app") as HTMLElement;
const style = document.createElement("style");
style.textContent = CSS;
document.head.append(style);

const title = document.createElement("h1");
title.textContent = "Allow the microphone";
const why = document.createElement("p");
why.textContent =
  "Voice input listens only after you press the mic button or the voice shortcut. Chrome turns your speech into text, which may happen on Google's servers. This page asks once so the extension is allowed to use the microphone, then closes the stream right away.";
const button = document.createElement("button");
button.type = "button";
button.textContent = "Allow microphone";
const status = document.createElement("p");
status.id = "status";
status.setAttribute("role", "status");
status.setAttribute("aria-live", "polite");

app.append(title, why, button, status);

function report(text: string, tone: "good" | "bad" | "") {
  status.textContent = text;
  status.className = tone;
}

async function requestMicrophone() {
  button.disabled = true;
  report("Waiting for your answer in the permission prompt...", "");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    report("Microphone enabled. You can close this tab.", "good");
    button.textContent = "Enabled";
    if (new URLSearchParams(location.search).has("resume")) {
      await chrome.runtime.sendMessage({ kind: "voicePermissionGranted" }).catch(() => undefined);
    }
  } catch (error) {
    const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
    report(denied ? "Microphone access was blocked. Allow it in the address bar icon, then press the button again." : "No microphone was found or it could not be opened.", "bad");
    button.disabled = false;
  }
}

button.addEventListener("click", () => void requestMicrophone());
if (new URLSearchParams(location.search).has("resume")) void requestMicrophone();
