import { DEFAULT_BACKEND_URL, LLM_PATH, LlmRequest, LlmResponse } from "@browser-agent/shared";

export async function callLlm(req: LlmRequest): Promise<LlmResponse> {
  const res = await fetch(`${DEFAULT_BACKEND_URL}${LLM_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(LlmRequest.parse(req)),
  });
  if (!res.ok) throw new Error(`backend responded ${res.status}`);
  return LlmResponse.parse(await res.json());
}
