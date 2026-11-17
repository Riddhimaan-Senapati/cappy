export type Rgba = { r: number; g: number; b: number; a: number };

const RGBA_RE = /rgba?\(\s*([\d.]+)(?:,|\s)+([\d.]+)(?:,|\s)+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/i;

export function parseRgba(css: string): Rgba | undefined {
  const m = RGBA_RE.exec(css.trim());
  if (!m) return undefined;
  const raw = m[4];
  const alpha = raw === undefined ? 1 : raw.endsWith("%") ? parseFloat(raw) / 100 : parseFloat(raw);
  return { r: parseFloat(m[1]!), g: parseFloat(m[2]!), b: parseFloat(m[3]!), a: Math.min(1, Math.max(0, alpha)) };
}

// Composites over an opaque backdrop (white by default) before taking WCAG relative luminance.
export function relativeLuminance(c: Rgba, backdrop = 255): number {
  const linear = (channel: number): number => {
    const v = (channel * c.a + backdrop * (1 - c.a)) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
}
