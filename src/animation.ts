import { visibleWidth } from "@earendil-works/pi-tui";
import {
  ansiColor,
  type HexColor,
  interpolateOklab,
  shimmerColor,
} from "./config.ts";
import { StreamMode, type StreamEvent, type WorkingView } from "./state.ts";

export const SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"] as const;
const CYCLE_MS = 2_000;
const WARNING = "#D97706" as HexColor;
const ERROR = "#DC2626" as HexColor;
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
let lastSegmentedMessage: string | undefined;
let lastSegments: readonly GraphemeSegment[] | undefined;

export interface IndicatorRender {
  readonly frames: readonly string[];
  readonly message: string;
}

export interface GraphemeSegment {
  readonly text: string;
  readonly start: number;
  readonly width: number;
}

export function animationIntervalMs(mode: StreamMode): number {
  return mode === StreamMode.Requesting ? 50 : 100;
}

export function shouldRenderStreamEvent(
  type: StreamEvent,
  modeChanged: boolean,
  reducedMotion = false,
): boolean {
  if (reducedMotion && type === "text_delta") return true;
  switch (type) {
    case "thinking_delta":
    case "text_delta":
    case "toolcall_delta":
      return modeChanged;
    default:
      return true;
  }
}

export function spinnerFrames(ghostty = isGhostty()): readonly string[] {
  return ghostty ? [...SPINNER_FRAMES.slice(0, -1), "✻"] : SPINNER_FRAMES;
}

export function isGhostty(): boolean {
  return (
    process.env.TERM_PROGRAM?.toLowerCase() === "ghostty" ||
    process.env.GHOSTTY_RESOURCES_DIR !== undefined
  );
}

export function spinnerGlyph(elapsedMs: number, ghostty = false): string {
  const frames = spinnerFrames(ghostty);
  const phase = (1 - Math.cos((2 * Math.PI * elapsedMs) / CYCLE_MS)) / 2;
  return frames[Math.round(phase * (frames.length - 1))] ?? frames[0];
}

export function segmentGraphemes(message: string): readonly GraphemeSegment[] {
  if (message === lastSegmentedMessage && lastSegments !== undefined) {
    return lastSegments;
  }

  let start = 0;
  const segments = [...GRAPHEME_SEGMENTER.segment(message)].map(
    ({ segment }) => {
      const width = visibleWidth(segment);
      const result = { text: segment, start, width };
      start += width;
      return result;
    },
  );
  lastSegmentedMessage = message;
  lastSegments = segments;
  return segments;
}

export function shimmerPosition(
  elapsedMs: number,
  messageWidth: number,
  mode: StreamMode,
): number {
  const cycleWidth = messageWidth + 20;
  const step = Math.floor(
    elapsedMs / (mode === StreamMode.Requesting ? 50 : 200),
  );
  return mode === StreamMode.Requesting
    ? (step % cycleWidth) - 10
    : messageWidth + 10 - (step % cycleWidth);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function intensityColor(base: HexColor, intensity: number): HexColor {
  const warningAmount = clamp(intensity * 2);
  const errorAmount = clamp(intensity * 2 - 1);
  return interpolateOklab(
    interpolateOklab(base, WARNING, warningAmount),
    ERROR,
    errorAmount,
  );
}

function coloredGlimmer(
  message: string,
  base: HexColor,
  glimmer: HexColor,
  position: number,
): string {
  const segments = segmentGraphemes(message);
  const bandStart = position - 1;
  const bandEnd = position + 1;
  let output = "";
  let runColor: HexColor | undefined;
  let runText = "";

  const flush = (): void => {
    if (runColor !== undefined) output += ansiColor(runColor, runText);
  };

  for (const { text, start, width } of segments) {
    const end = start + width;
    const color = end <= bandStart || start > bandEnd ? base : glimmer;
    if (color !== runColor) {
      flush();
      runColor = color;
      runText = text;
    } else {
      runText += text;
    }
  }
  flush();
  return output;
}

function renderMetadata(metadata: readonly string[]): string {
  return metadata.length === 0
    ? ""
    : ` ${DIM}(${metadata.join(" · ")})${RESET}`;
}

/** Render the primary message independently from dim, non-shimmered metadata. */
export function renderWorkingMessage(
  view: WorkingView,
  color: HexColor,
  elapsedMs: number,
  reducedMotion: boolean,
  shimmer = shimmerColor(color),
): string {
  const intensity = Math.max(view.thinkingIntensity, view.stalledIntensity);
  const base = intensityColor(color, intensity);
  const glimmer = intensityColor(shimmer, intensity);
  const noMovingBand = reducedMotion || view.stalledIntensity > 0;
  let primary: string;

  if (view.mode === StreamMode.ToolUse && !reducedMotion) {
    const flash = (Math.sin((elapsedMs / 1_000) * Math.PI) + 1) / 2;
    primary = ansiColor(interpolateOklab(base, glimmer, flash), view.primary);
  } else if (noMovingBand) {
    primary = ansiColor(base, view.primary);
  } else {
    const width = visibleWidth(view.primary);
    primary = coloredGlimmer(
      view.primary,
      base,
      glimmer,
      shimmerPosition(elapsedMs, width, view.mode),
    );
  }

  if (view.thinkingIntensity > 0.5) primary = `${BOLD}${primary}${RESET}`;
  return `${primary}${renderMetadata(view.metadata)}`;
}

/**
 * Render one declarative frame. The extension owns the clock and gives Pi one
 * already-rendered frame, so Pi's own indicator timer is never started.
 */
export function renderIndicator(
  view: WorkingView,
  color: HexColor,
  reducedMotion: boolean,
  elapsedMs = 0,
  ghostty = isGhostty(),
  shimmer = shimmerColor(color),
): IndicatorRender {
  const glyph = reducedMotion ? "●" : spinnerGlyph(elapsedMs, ghostty);
  const intensity = Math.max(view.thinkingIntensity, view.stalledIntensity);
  const spinnerColor = intensityColor(color, intensity);
  return {
    frames: [ansiColor(spinnerColor, glyph)],
    message: renderWorkingMessage(
      view,
      color,
      elapsedMs,
      reducedMotion,
      shimmer,
    ),
  };
}
