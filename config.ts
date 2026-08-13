import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { sanitizeTerminalText, VERBS } from "./state.ts";

export type HexColor = `#${string}`;
export type SpinnerVerbMode = "append" | "replace";

export interface SpinnerVerbConfig {
  readonly mode: SpinnerVerbMode;
  readonly verbs: readonly string[];
}

export interface FlairConfig {
  readonly colors: Readonly<Record<string, HexColor>>;
  readonly shimmers: Readonly<Record<string, HexColor>>;
  readonly fallback: HexColor;
  readonly spinnerVerbs?: SpinnerVerbConfig;
  readonly toolTimers: boolean;
}

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Oklab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

export const BUILTIN_COLORS: Readonly<Record<string, HexColor>> = Object.freeze(
  {
    deepseek: "#4D6BFE",
    claude: "#D77757",
    gemini: "#AD89EB",
    gpt: "#303030",
    qwen: "#615CED",
    glm: "#1F63EC",
    minimax: "#B4393C",
    gemma: "#0053D6",
    nvidia: "#76B900",
    kimi: "#040000",
  },
);

export const FALLBACK_COLOR: HexColor = "#A6A6A6";
export const DEFAULT_FLAIR_CONFIG: FlairConfig = Object.freeze({
  colors: Object.freeze({}) as Readonly<Record<string, HexColor>>,
  shimmers: Object.freeze({}) as Readonly<Record<string, HexColor>>,
  fallback: FALLBACK_COLOR,
  spinnerVerbs: undefined,
  toolTimers: false,
});
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Return every previewable model family, with user values taking precedence. */
export function configuredModelColors(
  config: FlairConfig,
): Readonly<Record<string, HexColor>> {
  return { ...BUILTIN_COLORS, ...config.colors };
}
let lastColorLookup:
  | {
      provider: string;
      modelId: string;
      config: FlairConfig;
      color: HexColor;
    }
  | undefined;
let lastModelShimmerLookup:
  | {
      provider: string;
      modelId: string;
      config: FlairConfig;
      base: HexColor;
      shimmer: HexColor;
    }
  | undefined;
let lastShimmerBase: HexColor | undefined;
let lastShimmer: HexColor | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validColor(value: unknown): value is HexColor {
  return typeof value === "string" && HEX_COLOR.test(value);
}

/** Parse only the user-level schema; malformed entries are ignored safely. */
export function parseFlairConfig(raw: string): FlairConfig {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return DEFAULT_FLAIR_CONFIG;

    const parseColorMap = (value: unknown): Record<string, HexColor> => {
      const result: Record<string, HexColor> = {};
      if (!isRecord(value)) return result;
      for (const [key, color] of Object.entries(value)) {
        const normalizedKey = key.trim().toLowerCase();
        if (normalizedKey && validColor(color)) result[normalizedKey] = color;
      }
      return result;
    };

    const parseSpinnerVerbs = (
      value: unknown,
    ): SpinnerVerbConfig | undefined => {
      if (!isRecord(value)) return undefined;
      const mode = value.mode;
      if (mode !== "append" && mode !== "replace") return undefined;
      const verbs = Array.isArray(value.verbs)
        ? value.verbs
            .filter((verb): verb is string => typeof verb === "string")
            .map((verb) => sanitizeTerminalText(verb).trim())
            .filter(Boolean)
        : [];
      return { mode, verbs };
    };

    return {
      ...DEFAULT_FLAIR_CONFIG,
      colors: parseColorMap(parsed.colors),
      shimmers: parseColorMap(parsed.shimmers),
      fallback: validColor(parsed.fallback) ? parsed.fallback : FALLBACK_COLOR,
      spinnerVerbs: parseSpinnerVerbs(parsed.spinnerVerbs),
      toolTimers: parsed.toolTimers === true,
    };
  } catch {
    return DEFAULT_FLAIR_CONFIG;
  }
}

export function configuredSpinnerVerbs(
  config: FlairConfig,
): readonly string[] {
  const spinnerVerbs = config.spinnerVerbs;
  const verbs = spinnerVerbs?.verbs
    .map((verb) => sanitizeTerminalText(verb).trim())
    .filter(Boolean) ?? [];
  if (spinnerVerbs?.mode === "replace" && verbs.length > 0) {
    return verbs;
  }
  if (spinnerVerbs?.mode === "append") {
    return [...VERBS, ...verbs];
  }
  return VERBS;
}

/** The extension deliberately reads no project-local configuration. */
export async function loadFlairConfig(agentDir: string): Promise<FlairConfig> {
  try {
    const raw = await readFile(join(agentDir, "flair.json"), "utf8");
    return parseFlairConfig(raw);
  } catch {
    return DEFAULT_FLAIR_CONFIG;
  }
}

function longestIdentityMatch<T>(
  provider: string | undefined,
  modelId: string | undefined,
  values: Readonly<Record<string, T>>,
): T | undefined {
  const identity = `${provider ?? ""}/${modelId ?? ""}`.toLowerCase();
  let bestKey = "";
  let bestValue: T | undefined;
  for (const [key, value] of Object.entries(values)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.length > bestKey.length &&
      identity.includes(normalizedKey)
    ) {
      bestKey = normalizedKey;
      bestValue = value;
    }
  }
  return bestValue;
}

export function colorForModel(
  provider: string | undefined,
  modelId: string | undefined,
  config: FlairConfig,
): HexColor {
  const normalizedProvider = provider ?? "";
  const normalizedModelId = modelId ?? "";
  const cached = lastColorLookup;
  if (
    cached?.provider === normalizedProvider &&
    cached.modelId === normalizedModelId &&
    cached.config === config
  ) {
    return cached.color;
  }

  const colors = { ...BUILTIN_COLORS, ...config.colors };
  const color = longestIdentityMatch(
    normalizedProvider,
    normalizedModelId,
    colors,
  ) ?? config.fallback;
  lastColorLookup = {
    provider: normalizedProvider,
    modelId: normalizedModelId,
    config,
    color,
  };
  return color;
}

/** Resolve an explicit model shimmer, or derive one from its base color. */
export function shimmerForModel(
  provider: string | undefined,
  modelId: string | undefined,
  config: FlairConfig,
  base = colorForModel(provider, modelId, config),
): HexColor {
  const normalizedProvider = provider ?? "";
  const normalizedModelId = modelId ?? "";
  const cached = lastModelShimmerLookup;
  if (
    cached?.provider === normalizedProvider &&
    cached.modelId === normalizedModelId &&
    cached.config === config &&
    cached.base === base
  ) {
    return cached.shimmer;
  }

  const shimmer = longestIdentityMatch(
    normalizedProvider,
    normalizedModelId,
    config.shimmers,
  ) ?? shimmerColor(base);
  lastModelShimmerLookup = {
    provider: normalizedProvider,
    modelId: normalizedModelId,
    config,
    base,
    shimmer,
  };
  return shimmer;
}

export function ansiColor(color: HexColor, text: string): string {
  const rgb = color.slice(1);
  return `\x1b[38;2;${parseInt(rgb.slice(0, 2), 16)};${parseInt(rgb.slice(2, 4), 16)};${parseInt(rgb.slice(4, 6), 16)}m${text}\x1b[39m`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function hexToRgb(hex: HexColor): Rgb {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16) / 255,
    g: Number.parseInt(hex.slice(3, 5), 16) / 255,
    b: Number.parseInt(hex.slice(5, 7), 16) / 255,
  };
}

export function rgbToHex(rgb: Rgb): HexColor {
  const channel = (value: number): string =>
    Math.round(clamp01(value) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

export function srgbToLinear(value: number): number {
  const channel = clamp01(value);
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const channel = Math.abs(value);
  const encoded = channel <= 0.0031308
    ? 12.92 * channel
    : 1.055 * channel ** (1 / 2.4) - 0.055;
  return sign * encoded;
}

export function rgbToOklab(rgb: Rgb): Oklab {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export function oklabToRgb(lab: Oklab): Rgb {
  const l = lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const m = lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const s = lab.l - 0.0894841775 * lab.a - 1.291485548 * lab.b;
  const l3 = l ** 3;
  const m3 = m ** 3;
  const s3 = s ** 3;
  return {
    r: linearToSrgb(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
    g: linearToSrgb(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
    b: linearToSrgb(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
  };
}

export function oklabToOklch(lab: Oklab): Oklch {
  return { l: lab.l, c: Math.hypot(lab.a, lab.b), h: Math.atan2(lab.b, lab.a) };
}

export function oklchToOklab(lch: Oklch): Oklab {
  return { l: lch.l, a: lch.c * Math.cos(lch.h), b: lch.c * Math.sin(lch.h) };
}

export function hexToOklab(hex: HexColor): Oklab {
  return rgbToOklab(hexToRgb(hex));
}

export function hexToOklch(hex: HexColor): Oklch {
  return oklabToOklch(hexToOklab(hex));
}

export function oklabToHex(lab: Oklab): HexColor {
  return rgbToHex(oklabToRgb(lab));
}

export function oklchToHex(lch: Oklch): HexColor {
  return oklabToHex(oklchToOklab(lch));
}

/** Return the highest-chroma in-gamut color at this OKLCH lightness and hue. */
export function gamutMapOklch(lch: Oklch): HexColor {
  const lightness = clamp01(lch.l);
  let low = 0;
  let high = Math.max(0, lch.c);
  let best: Rgb = oklabToRgb({ l: lightness, a: 0, b: 0 });

  for (let iteration = 0; iteration < 24; iteration += 1) {
    const chroma = (low + high) / 2;
    const candidate = oklabToRgb(
      oklchToOklab({ l: lightness, c: chroma, h: lch.h }),
    );
    if (
      candidate.r >= 0 &&
      candidate.r <= 1 &&
      candidate.g >= 0 &&
      candidate.g <= 1 &&
      candidate.b >= 0 &&
      candidate.b <= 1
    ) {
      best = candidate;
      low = chroma;
    } else {
      high = chroma;
    }
  }

  return rgbToHex(best);
}

/** Claude's observed pair is closely approximated by +0.092 L and -3% C. */
export function shimmerColor(base: HexColor): HexColor {
  if (base === lastShimmerBase && lastShimmer !== undefined) return lastShimmer;

  const source = hexToOklch(base);
  const shimmer = gamutMapOklch({
    l: Math.min(1, source.l + 0.092),
    c: source.c * 0.97,
    h: source.h,
  });
  lastShimmerBase = base;
  lastShimmer = shimmer;
  return shimmer;
}

/** Interpolate animated colors in OKLab, not gamma-encoded sRGB. */
export function interpolateOklab(
  from: HexColor,
  to: HexColor,
  amount: number,
): HexColor {
  const t = clamp01(amount);
  const a = hexToOklab(from);
  const b = hexToOklab(to);
  return oklabToHex({
    l: a.l + (b.l - a.l) * t,
    a: a.a + (b.a - a.a) * t,
    b: a.b + (b.b - a.b) * t,
  });
}
