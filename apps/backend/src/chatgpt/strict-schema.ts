// OpenAI strict structured outputs require every property listed in `required` and no extra properties,
// so optional fields become nullable here and the nulls are removed again before zod validation.
export function toStrictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toStrictSchema);
  if (node === null || typeof node !== "object") return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) out[k === "oneOf" ? "anyOf" : k] = k === "properties" ? v : toStrictSchema(v);
  if (src.type === "object" && src.properties && typeof src.properties === "object") {
    const required = new Set(Array.isArray(src.required) ? (src.required as string[]) : []);
    const props: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(src.properties as Record<string, unknown>)) {
      const strict = toStrictSchema(schema);
      props[key] = required.has(key) ? strict : { anyOf: [strict, { type: "null" }] };
    }
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== null) out[k] = stripNulls(v);
  return out;
}
