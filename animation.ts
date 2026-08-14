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
const THINKING_PULSE_START_MS = 3_000;
const THINKING_PULSE_MS = 2_000;
const THINKING_PULSE_DIM = "#999999" as HexColor;
const THINKING_PULSE_BRIGHT = "#B9B9B9" as HexColor;
const WARNING = "#D97706" as HexColor;
const ERROR = "#DC2626" as HexColor;
const WORKING_ROW_EDGE_PADDING = 2;
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

/** Match Claude's status pulse, which uses rounded sRGB channel interpolation. */
function interpolateRgb(
  from: HexColor,
  to: HexColor,
  amount: number,
): HexColor {
  const t = clamp(amount);
  const channel = (offset: number): string =>
    Math.round(
      Number.parseInt(from.slice(offset, offset + 2), 16) +
        (Number.parseInt(to.slice(offset, offset + 2), 16) -
          Number.parseInt(from.slice(offset, offset + 2), 16)) * t,
    )
      .toString(16)
      .padStart(2, "0");
  return `#${channel(1)}${channel(3)}${channel(5)}` as HexColor;
}

function thinkingStatusColor(
  elapsedMs: number,
  thinkingIntensity: number,
): HexColor {
  const pulse = elapsedMs < THINKING_PULSE_START_MS
    ? 0
    : (Math.sin(
        ((elapsedMs - THINKING_PULSE_START_MS) / THINKING_PULSE_MS) *
          Math.PI *
          2,
      ) + 1) / 2;
  const neutral = interpolateRgb(
    THINKING_PULSE_DIM,
    THINKING_PULSE_BRIGHT,
    pulse,
  );
  return thinkingIntensity > 0
    ? interpolateRgb(neutral, WARNING, thinkingIntensity)
    : neutral;
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

function workingIntensity(view: WorkingView): number {
  return Math.max(view.thinkingIntensity, view.stalledIntensity, view.recoveryIntensity);
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

function isActiveThinkingStatus(value: string): boolean {
  return /^(?:thinking|still thinking|thinking more|thinking some more|almost done thinking)(?: with .+ effort)?$/.test(value);
}

function isSemanticStatus(value: string): boolean {
  return (
    isActiveThinkingStatus(value) ||
    value.startsWith("running tool for ") ||
    value.startsWith("ran tool for ") ||
    value.startsWith("thought for ")
  );
}

function metadataWidth(metadata: readonly string[]): number {
  return metadata.length === 0
    ? 0
    : 1 + visibleWidth(`(${metadata.join(" · ")})`);
}

function renderMetadata(
  metadata: readonly string[],
  thinkingColor: HexColor,
  availableWidth = Number.POSITIVE_INFINITY,
): string {
  if (metadata.length === 0) return "";

  let statusIndex = -1;
  for (let index = metadata.length - 1; index >= 0; index -= 1) {
    if (isSemanticStatus(metadata[index]!)) {
      statusIndex = index;
      break;
    }
  }

  let statusText = statusIndex >= 0 ? metadata[statusIndex] : undefined;
  if (statusText !== undefined && metadataWidth([statusText]) > availableWidth) {
    if (
      isActiveThinkingStatus(statusText) &&
      statusText !== "thinking" &&
      metadataWidth(["thinking"]) <= availableWidth
    ) {
      statusText = "thinking";
    } else {
      statusText = undefined;
    }
  }

  const selectedIndexes = new Set<number>();
  const selectedForBudget: string[] = [];
  if (statusText !== undefined) {
    selectedIndexes.add(statusIndex);
    selectedForBudget.push(statusText);
  }

  for (let index = 0; index < metadata.length; index += 1) {
    if (index === statusIndex) continue;
    const candidate = metadata[index]!;
    if (metadataWidth([...selectedForBudget, candidate]) <= availableWidth) {
      selectedIndexes.add(index);
      selectedForBudget.push(candidate);
    }
  }

  const items = metadata
    .map((item, index) => {
      if (!selectedIndexes.has(index)) return undefined;
      const text = index === statusIndex ? statusText! : item;
      return isActiveThinkingStatus(text)
        ? ansiColor(thinkingColor, text)
        : `${DIM}${text}${RESET}`;
    })
    .filter((item): item is string => item !== undefined);
  if (items.length === 0) return "";
  return ` ${DIM}(${RESET}${items.join(`${DIM} · ${RESET}`)}${DIM})${RESET}`;
}

/** Render the primary message independently from dim, non-shimmered metadata. */
export function renderWorkingMessage(
  view: WorkingView,
  color: HexColor,
  elapsedMs: number,
  reducedMotion: boolean,
  shimmer = shimmerColor(color),
  availableWidth = Number.POSITIVE_INFINITY,
): string {
  const intensity = workingIntensity(view);
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
  const statusColor = thinkingStatusColor(
    elapsedMs,
    view.thinkingIntensity,
  );
  return `${primary}${renderMetadata(
    view.metadata,
    statusColor,
    availableWidth,
  )}`;
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
  terminalWidth?: number,
): IndicatorRender {
  const glyph = reducedMotion ? "●" : spinnerGlyph(elapsedMs, ghostty);
  const intensity = workingIntensity(view);
  const spinnerColor = intensityColor(color, intensity);
  const metadataWidth = terminalWidth === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(
        0,
        terminalWidth -
          visibleWidth(`${glyph} ${view.primary}`) -
          WORKING_ROW_EDGE_PADDING,
      );
  return {
    frames: [ansiColor(spinnerColor, glyph)],
    message: renderWorkingMessage(
      view,
      color,
      elapsedMs,
      reducedMotion,
      shimmer,
      metadataWidth,
    ),
  };
}
