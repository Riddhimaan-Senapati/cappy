import { DEFAULT_BACKEND_URL, REQUEST_PATH, RequestBody, type PageOutline, type Profile } from "@browser-agent/shared";
import { OutlineReply } from "./messages";

export function buildRequestBody(reply: OutlineReply, profile: Profile, request: string): RequestBody {
  return RequestBody.parse({ url: reply.url, outline: reply.outline satisfies PageOutline, profile, request });
}

export async function postRequest(body: RequestBody): Promise<unknown> {
  const res = await fetch(`${DEFAULT_BACKEND_URL}${REQUEST_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`backend responded ${res.status}`);
  return res.json();
}

export function parseOutlineReply(raw: unknown): OutlineReply | undefined {
  const parsed = OutlineReply.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
