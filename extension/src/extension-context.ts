export function reportExtensionError(error: unknown) {
  if (!chrome.runtime?.id || (error instanceof Error && error.message.includes("Extension context invalidated"))) return;
  console.error(error);
}
