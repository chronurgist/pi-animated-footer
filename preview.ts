import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderIndicator, segmentGraphemes } from "./animation.ts";
import {
  configuredModelColors,
  type FlairConfig,
  type HexColor,
  loadFlairConfig,
  shimmerForModel,
} from "./config.ts";
import { StreamMode, type WorkingView } from "./state.ts";

const FRAME_INTERVAL_MS = 50;
const ROW_PREFIX_WIDTH = 24;
const MAX_KEY_WIDTH = 28;
const ENTER_SCREEN = "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l";
const LEAVE_SCREEN = "\x1b[0m\x1b[?25h\x1b[?1049l";
const ANSI_CSI = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);

type Timer = ReturnType<typeof setInterval>;

export interface PreviewRow {
  readonly key: string;
  readonly color: HexColor;
  readonly shimmer: HexColor;
}

/** Build the stable, sorted set of rows shown by the preview. */
export function buildPreviewRows(config: FlairConfig): readonly PreviewRow[] {
  return Object.entries(configuredModelColors(config))
    .map(([key, color]) => ({
      key,
      color,
      shimmer: shimmerForModel("", key, config, color),
    }))
    .sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
    );
}

function cleanKey(key: string): string {
  return key.replace(/\p{Cc}/gu, " ").trim();
}

function truncateColumns(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return "…";

  let output = "";
  let width = 0;
  for (const segment of segmentGraphemes(text)) {
    if (width + segment.width > maxWidth - 1) break;
    output += segment.text;
    width += segment.width;
  }
  return `${output}…`;
}

function padColumns(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function workingView(primary: string): WorkingView {
  return {
    mode: StreamMode.Responding,
    primary,
    metadata: [],
    thinkingIntensity: 0,
    stalledIntensity: 0,
    recoveryIntensity: 0,
  };
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI, "");
}

function layout(
  rows: readonly PreviewRow[],
  terminalWidth: number,
): {
  keyWidth: number;
  messageWidth: number;
} {
  const largestKey = Math.max(
    1,
    ...rows.map((row) => visibleWidth(cleanKey(row.key))),
  );
  const available = Math.max(1, terminalWidth - ROW_PREFIX_WIDTH);
  const keyWidth = Math.min(
    largestKey,
    MAX_KEY_WIDTH,
    Math.max(1, Math.floor(available / 2)),
  );
  return {
    keyWidth,
    messageWidth: Math.max(1, terminalWidth - ROW_PREFIX_WIDTH - keyWidth),
  };
}

interface PreviewLayout {
  readonly keyWidth: number;
  readonly messageWidth: number;
}

function renderRow(
  row: PreviewRow,
  elapsedMs: number,
  dimensions: PreviewLayout,
): string {
  const { keyWidth, messageWidth } = dimensions;
  const key = truncateColumns(cleanKey(row.key), keyWidth);
  const primary = truncateColumns(`${key} is Thinking…`, messageWidth);
  const rendered = renderIndicator(
    workingView(primary),
    row.color,
    false,
    elapsedMs,
    undefined,
    row.shimmer,
  );
  return `${padColumns(key, keyWidth)}  ${row.color}  ${row.shimmer}  ${rendered.frames[0]} ${rendered.message}`;
}

function staticTable(rows: readonly PreviewRow[]): string {
  const keyWidth = Math.max(
    5,
    ...rows.map((row) => visibleWidth(cleanKey(row.key))),
  );
  const header = `${padColumns("MODEL", keyWidth)}  BASE     SHIMMER  MESSAGE`;
  const lines = rows.map((row) => {
    const key = cleanKey(row.key);
    const message = stripAnsi(
      renderIndicator(workingView(`${key} is Thinking…`), row.color, false, 0)
        .message,
    );
    return `${padColumns(key, keyWidth)}  ${row.color}  ${row.shimmer}  ${message}`;
  });
  return ["Claude-style spinner preview", "", header, ...lines].join("\n");
}

function runInteractive(rows: readonly PreviewRow[]): void {
  const terminalWidth = (): number => Math.max(1, process.stdout.columns ?? 80);
  let timer: Timer | undefined;
  let stopped = false;
  let screenActive = false;

  const cleanup = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("exit", onExit);
    if (!screenActive) return;
    screenActive = false;
    try {
      process.stdout.write(LEAVE_SCREEN);
    } catch {
      // The terminal may already be closed while handling a signal.
    }
  };

  const stop = (): void => cleanup();
  const onExit = (): void => cleanup();

  const draw = (): void => {
    const width = terminalWidth();
    const elapsedMs = Date.now() - startedAt;
    const dimensions = layout(rows, width);
    const lines = rows.map((row) => renderRow(row, elapsedMs, dimensions));
    const content = [
      "Claude-style spinner preview",
      "Ctrl-C to exit",
      "",
      formatHeader(rows, width),
      ...lines,
    ].join("\n");

    // Render from a fixed origin. Relative cursor movement breaks as soon as a
    // terminal wraps one row, leaving repeated trailing rows behind.
    process.stdout.write(`\x1b[H${content}\x1b[J`);
  };

  const startedAt = Date.now();
  process.stdout.write(ENTER_SCREEN);
  screenActive = true;
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.on("exit", onExit);

  try {
    draw();
    timer = setInterval(() => {
      if (stopped) return;
      try {
        draw();
      } catch (error) {
        cleanup();
        process.stderr.write(
          `Preview stopped: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      }
    }, FRAME_INTERVAL_MS);
  } catch (error) {
    cleanup();
    throw error;
  }
}

function formatHeader(
  rows: readonly PreviewRow[],
  terminalWidth: number,
): string {
  const { keyWidth, messageWidth } = layout(rows, terminalWidth);
  return `${padColumns(truncateColumns("MODEL", keyWidth), keyWidth)}  BASE     SHIMMER  ${truncateColumns("MESSAGE", messageWidth)}`;
}

async function main(): Promise<void> {
  const config = await loadFlairConfig(getAgentDir());
  const rows = buildPreviewRows(config);

  if (!process.stdout.isTTY) {
    process.stdout.write(`${staticTable(rows)}\n`);
    return;
  }

  runInteractive(rows);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Preview failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
