export type AccentPalette = {
  fill: string;
  hover: string;
  active: string;
  soft: string;
  border: string;
  borderActive: string;
  ring: string;
  on: string;
  glow: string;
  shadow: string;
  shadowActive: string;
};

type RGB = { r: number; g: number; b: number };
type HSL = { h: number; s: number; l: number };

const CANVAS_SIZE = 96;
const SAMPLE_STEP = 4; // sample every nth pixel
const BUCKET_SIZE = 32;
const MIN_HUE_DISTANCE = 0.22; // ensure noticeably distinct hues (~80°)
const MIN_SATURATION = 0.2;

export const ACCENT_PALETTE_KEYS: Array<keyof AccentPalette> = [
  "fill",
  "hover",
  "active",
  "soft",
  "border",
  "borderActive",
  "ring",
  "on",
  "glow",
  "shadow",
  "shadowActive",
];

export function normalizeAccentPalette(raw: unknown): AccentPalette | null {
  if (!raw || typeof raw !== "object") return null;
  const result: Partial<AccentPalette> = {};
  for (const key of ACCENT_PALETTE_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value !== "string" || !value.trim()) return null;
    result[key] = value;
  }
  return result as AccentPalette;
}

export async function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Unsupported file result"));
    };
    reader.readAsDataURL(file);
  });
}

export async function buildAccentPalettesFromImage(dataUrl: string): Promise<AccentPalette[]> {
  const image = await loadImage(dataUrl);
  const candidates = extractPaletteCandidates(image);
  if (!candidates.length) {
    return [createPalette({ r: 52, g: 199, b: 89 })];
  }

  const segmentBest = new Map<number, PaletteCandidate>();
  for (const candidate of candidates) {
    const hue = candidate.hsl.h;
    const segment = Number.isFinite(hue) ? Math.floor((hue * 360) / 60) % 6 : -1;
    if (segment < 0) continue;
    const existing = segmentBest.get(segment);
    if (!existing || candidate.weight > existing.weight) {
      segmentBest.set(segment, candidate);
    }
  }

  let choices = Array.from(segmentBest.values()).sort((a, b) => b.weight - a.weight);
  if (!choices.length) choices = candidates;

  const selected: RGB[] = [];
  const selectedHues: number[] = [];
  for (const candidate of choices) {
    if (selected.length >= 3) break;
    if (candidate.hsl.s < MIN_SATURATION) continue;
    if (selectedHues.some((h) => hueDistance(h, candidate.hsl.h) < MIN_HUE_DISTANCE)) continue;
    selected.push(candidate.rgb);
    selectedHues.push(candidate.hsl.h);
  }

  if (selected.length === 0) {
    const fallback = candidates[0];
    selected.push(fallback.rgb);
    selectedHues.push(fallback.hsl.h);
  }

  if (selected.length < 3) {
    const base = selected[0];
    const variants = generateVariants(base, selectedHues, 3 - selected.length);
    for (const rgb of variants) {
      if (selected.length >= 3) break;
      const hue = rgbToHsl(rgb.r, rgb.g, rgb.b).h;
      if (selectedHues.some((h) => hueDistance(h, hue) < MIN_HUE_DISTANCE)) continue;
      selected.push(rgb);
      selectedHues.push(hue);
    }
  }

  if (selected.length < 3) {
    for (const candidate of candidates) {
      if (selected.length >= 3) break;
      if (selectedHues.some((h) => hueDistance(h, candidate.hsl.h) < MIN_HUE_DISTANCE / 1.4)) continue;
      selected.push(candidate.rgb);
      selectedHues.push(candidate.hsl.h);
    }
  }

  while (selected.length < 3) {
    const baseHue = rgbToHsl(selected[0].r, selected[0].g, selected[0].b).h;
    const hue = (baseHue + 0.33 * selected.length) % 1;
    const rgb = roundColor(hslToRgb(hue, 0.55, clamp01(0.56 - selected.length * 0.08)));
    selected.push(rgb);
    selectedHues.push(hue);
  }

  return selected.slice(0, 3).map((rgb) => createPalette(rgb));
}

export function normalizeAccentPaletteList(raw: unknown): AccentPalette[] | null {
  if (!Array.isArray(raw)) return null;
  const list: AccentPalette[] = [];
  for (const item of raw) {
    const palette = normalizeAccentPalette(item);
    if (!palette) return null;
    list.push(palette);
  }
  return list;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}

type PaletteCandidate = { rgb: RGB; hsl: HSL; weight: number };

function extractPaletteCandidates(image: HTMLImageElement): PaletteCandidate[] {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];

  const scale = Math.min(1, CANVAS_SIZE / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(image, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;

  const buckets = new Map<string, { weight: number; total: RGB }>();
  let totalWeight = 0;
  let avg: RGB = { r: 0, g: 0, b: 0 };

  for (let i = 0; i < data.length; i += SAMPLE_STEP * 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 160) continue;

    const hsl = rgbToHsl(r, g, b);
    const saturationWeight = clamp01(hsl.s * 1.8 + 0.2);
    const lightnessCentering = 1 - Math.abs(hsl.l - 0.5) * 1.4;
    const luminance = relativeLuminance({ r, g, b });
    const luminancePref = luminance < 0.1 || luminance > 0.92 ? 0.2 : 1;
    const weight = (saturationWeight + 0.35) * lightnessCentering * luminancePref;
    if (weight <= 0.01) continue;

    const key = `${Math.round(r / BUCKET_SIZE)}-${Math.round(g / BUCKET_SIZE)}-${Math.round(b / BUCKET_SIZE)}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.weight += weight;
      bucket.total.r += r * weight;
      bucket.total.g += g * weight;
      bucket.total.b += b * weight;
    } else {
      buckets.set(key, {
        weight,
        total: { r: r * weight, g: g * weight, b: b * weight },
      });
    }

    avg.r += r * weight;
    avg.g += g * weight;
    avg.b += b * weight;
    totalWeight += weight;
  }

  if (totalWeight > 0) {
    avg = {
      r: avg.r / totalWeight,
      g: avg.g / totalWeight,
      b: avg.b / totalWeight,
    };
  }

  let best: RGB | null = null;
  let bestWeight = 0;
  for (const bucket of buckets.values()) {
    if (bucket.weight > bestWeight) {
      bestWeight = bucket.weight;
      best = {
        r: bucket.total.r / bucket.weight,
        g: bucket.total.g / bucket.weight,
        b: bucket.total.b / bucket.weight,
      };
    }
  }

  const candidates: PaletteCandidate[] = [];
  if (best) {
    const bestRounded = roundColor(best);
    candidates.push({ rgb: bestRounded, hsl: rgbToHsl(bestRounded.r, bestRounded.g, bestRounded.b), weight: bestWeight });
  }

  for (const bucket of buckets.values()) {
    const rgb = {
      r: bucket.total.r / bucket.weight,
      g: bucket.total.g / bucket.weight,
      b: bucket.total.b / bucket.weight,
    };
    const rounded = roundColor(rgb);
    const hsl = rgbToHsl(rounded.r, rounded.g, rounded.b);
    if (!Number.isFinite(hsl.h) || bucket.weight < totalWeight * 0.02) continue;
    candidates.push({ rgb: rounded, hsl, weight: bucket.weight });
  }

  if (totalWeight > 0) {
    const avgRounded = roundColor(avg);
    candidates.push({ rgb: avgRounded, hsl: rgbToHsl(avgRounded.r, avgRounded.g, avgRounded.b), weight: totalWeight * 0.08 });
  }

  const unique: PaletteCandidate[] = [];
  for (const candidate of candidates.sort((a, b) => b.weight - a.weight)) {
    if (unique.some(existing => colorDistance(existing.rgb, candidate.rgb) < 18)) continue;
    unique.push(candidate);
  }

  return unique;
}

function createPalette(color: RGB): AccentPalette {
  const baseHsl = rgbToHsl(color.r, color.g, color.b);
  const targetSat = clamp01(Math.max(baseHsl.s, 0.38) * 1.22 + 0.08);
  const targetLight = (() => {
    if (baseHsl.l < 0.28) return 0.58;
    if (baseHsl.l > 0.78) return 0.48;
    return clamp01(baseHsl.l * 0.6 + 0.2);
  })();
  const accentRgb = roundColor(hslToRgb(baseHsl.h, targetSat, targetLight));
  const hover = adjustLightness(accentRgb, 0.12);
  const active = adjustLightness(accentRgb, -0.14);
  const soft = rgba(accentRgb, 0.24);
  const border = rgba(accentRgb, 0.46);
  const borderActive = rgba(accentRgb, 0.72);
  const ring = rgba(accentRgb, 0.34);
  const lum = relativeLuminance(accentRgb);
  const on = lum > 0.62 ? "#061428" : "#f5f9ff";
  const glow = `0 20px 36px ${rgba(accentRgb, 0.3)}`;
  const shadow = `0 14px 30px ${rgba(accentRgb, 0.32)}`;
  const shadowActive = `0 20px 40px ${rgba(accentRgb, 0.44)}`;

  return {
    fill: rgbToHex(accentRgb),
    hover,
    active,
    soft,
    border,
    borderActive,
    ring,
    on,
    glow,
    shadow,
    shadowActive,
  };
}

function adjustLightness(color: RGB, delta: number): string {
  const { h, s, l } = rgbToHsl(color.r, color.g, color.b);
  const adjusted = hslToRgb(h, clamp01(s * 1.05), clamp01(l + delta));
  return rgbToHex(adjusted);
}

function rgba(color: RGB, alpha: number): string {
  const c = roundColor(color);
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${clamp01(alpha).toFixed(2)})`;
}

function hueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return Math.min(diff, 1 - diff);
}

function roundColor(color: RGB): RGB {
  return {
    r: clampChannel(color.r),
    g: clampChannel(color.g),
    b: clampChannel(color.b),
  };
}

function generateVariants(base: RGB, existingHues: number[], count: number): RGB[] {
  const variants: RGB[] = [];
  const baseHsl = rgbToHsl(base.r, base.g, base.b);
  const hueOffsets = [0.33, -0.33, 0.5, -0.5, 0.17, -0.17, 0.25, -0.25];
  for (const offset of hueOffsets) {
    if (variants.length >= count) break;
    const hue = (baseHsl.h + offset + 1) % 1;
    if (existingHues.some((h) => hueDistance(h, hue) < MIN_HUE_DISTANCE)) continue;
    const sat = clamp01(Math.max(baseHsl.s, 0.45) + 0.1);
    const lightBase = baseHsl.l * 0.6 + 0.18;
    const light = clamp01(offset > 0 ? lightBase + 0.1 : lightBase - 0.08);
    const rgb = roundColor(hslToRgb(hue, sat, light));
    variants.push(rgb);
  }
  if (variants.length < count) {
    const complementHue = (baseHsl.h + 0.5) % 1;
    if (!existingHues.some((h) => hueDistance(h, complementHue) < MIN_HUE_DISTANCE)) {
      variants.push(roundColor(hslToRgb(complementHue, clamp01(baseHsl.s * 0.8 + 0.2), clamp01(0.52))));
    }
  }
  return variants.slice(0, count);
}

function colorDistance(a: RGB, b: RGB): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function rgbToHex({ r, g, b }: RGB): string {
  return `#${channelToHex(r)}${channelToHex(g)}${channelToHex(b)}`;
}

function channelToHex(value: number): string {
  const v = clampChannel(value);
  const hex = v.toString(16).padStart(2, "0");
  return hex;
}

function rgbToHsl(r: number, g: number, b: number): HSL {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }

  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): RGB {
  let r: number;
  let g: number;
  let b: number;

  if (s === 0) {
    r = g = b = l; // achromatic
  } else {
    const hue2rgb = (p: number, q: number, t: number): number => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return {
    r: r * 255,
    g: g * 255,
    b: b * 255,
  };
}

function relativeLuminance(color: RGB): number {
  const transform = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const r = transform(color.r);
  const g = transform(color.g);
  const b = transform(color.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
