import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

export enum StreamMode {
  ToolInput = "tool-input",
  ToolUse = "tool-use",
  Requesting = "requesting",
  Responding = "responding",
  Thinking = "thinking",
}

export type StreamEvent = AssistantMessageEvent["type"] | "done:toolUse";

/** Normalize the one stream event whose reason changes its UI mode. */
export function normalizeStreamEvent(event: AssistantMessageEvent): StreamEvent {
  return event.type === "done" && event.reason === "toolUse"
    ? "done:toolUse"
    : event.type;
}

export const VERBS = [
  "Thinking", "Working", "Crafting", "Reasoning", "Exploring", "Inspecting",
  "Preparing", "Considering", "Mapping", "Checking", "Planning", "Synthesizing",
  "Investigating", "Formulating", "Reviewing",
] as const;

export function chooseVerb(
  random: () => number = Math.random,
  verbs: readonly string[] = VERBS,
): string {
  return verbs[Math.floor(random() * verbs.length)] ?? "Working";
}

export interface ToolCallState {
  readonly name: string;
  readonly args: unknown;
  readonly startedAt: number;
}

export interface WorkingView {
  readonly mode: StreamMode;
  readonly primary: string;
  readonly metadata: readonly string[];
  readonly thinkingIntensity: number;
  readonly stalledIntensity: number;
  readonly recoveryIntensity: number;
}

const ELLIPSIS = "…";
const THINKING_STATUS_DELAY = 300;
const TOOL_TIMER_THRESHOLD = 2_000;
const ELAPSED_TIME_DELAY = 16_000;
const SHORT_STATUS_WINDOW = 2_000;
const RESPONSE_CATCH_UP_MS = 50;
const RECOVERY_MS = 300;

export function catchUpCharacters(displayed: number, target: number): number {
  const remainder = Math.max(0, target - displayed);
  if (remainder === 0) return displayed;
  const increment = remainder < 10
    ? 3
    : remainder < 100
      ? Math.max(8, Math.floor(remainder * 0.15))
      : 50;
  return Math.min(target, displayed + increment);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function short(value: string | undefined, fallback: string): string {
  const readable = sanitizeTerminalText(value ?? fallback).trim() || fallback;
  return readable.length > 56 ? `${readable.slice(0, 53)}…` : readable;
}

export function activeToolMessage(name: string, args: unknown): string | undefined {
  const input = typeof args === "object" && args !== null ? args as Record<string, unknown> : {};
  switch (name.toLowerCase()) {
    case "read": return `Reading ${short(asString(input.path), "file")}`;
    case "bash": return `Running ${short(asString(input.command), "command")}`;
    case "grep": return `Searching ${short(asString(input.pattern), "files")}`;
    case "find": return `Finding ${short(asString(input.pattern), "files")}`;
    case "ls": return `Listing ${short(asString(input.path), ".")}`;
    case "edit": return `Editing ${short(asString(input.path), "file")}`;
    case "write": return `Writing ${short(asString(input.path), "file")}`;
    default: return undefined;
  }
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function thinkingLabel(milliseconds: number): string {
  if (milliseconds < 10_000) return "thinking";
  if (milliseconds < 20_000) return "still thinking";
  if (milliseconds < 30_000) return "thinking more";
  if (milliseconds < 45_000) return "thinking some more";
  return "almost done thinking";
}

export function rampIntensity(elapsed: number, delay = 10_000, ramp = 10_000): number {
  return Math.max(0, Math.min(1, (elapsed - delay) / ramp));
}

/** Invert x(t) for CSS ease, then evaluate y(t). */
function cssEase(progress: number): number {
  const target = Math.max(0, Math.min(1, progress));
  let t = target;
  for (let i = 0; i < 5; i += 1) {
    const x = 0.75 * t * (1 - t) + t ** 3;
    t -= (x - target) / (0.75 - 1.5 * t + 3 * t ** 2);
  }
  return 0.3 * t * (1 - t) ** 2 + 3 * t ** 2 * (1 - t) + t ** 3;
}

export class TurnState {
  constructor(
    private readonly verbs: readonly string[] = VERBS,
    private readonly toolTimers = false,
  ) {}

  private startedAt = 0;
  private verb = "Working";
  private mode: StreamMode = StreamMode.Requesting;
  private thinkingStartedAt: number | undefined;
  private recoveryStartedAt = 0;
  private recoveryFrom = 0;
  private thoughtForMs: number | undefined;
  private thoughtForUntil = 0;
  private lastResponseAt: number | undefined;
  private responseCharacters = 0;
  private displayedCharacters = 0;
  private displayedCharactersAt: number | undefined;
  private readonly responseBlocks = new Map<number, number>();
  private readonly tools = new Map<string, ToolCallState>();
  private lastToolDuration: number | undefined;
  private lastToolUntil = 0;
  private latestToolId: string | undefined;

  startTurn(now: number, random: () => number = Math.random): void {
    this.clearTurnState(now, now);
    this.verb = chooseVerb(random, this.verbs);
  }

  reset(): void {
    this.clearTurnState(0, undefined);
  }

  private clearTurnState(
    startedAt: number,
    displayedCharactersAt: number | undefined,
  ): void {
    this.startedAt = startedAt;
    this.mode = StreamMode.Requesting;
    this.thinkingStartedAt = undefined;
    this.recoveryFrom = 0;
    this.thoughtForMs = undefined;
    this.thoughtForUntil = 0;
    this.lastResponseAt = undefined;
    this.responseCharacters = 0;
    this.displayedCharacters = 0;
    this.displayedCharactersAt = displayedCharactersAt;
    this.responseBlocks.clear();
    this.tools.clear();
    this.lastToolDuration = undefined;
    this.lastToolUntil = 0;
    this.latestToolId = undefined;
  }

  acceptStreamEvent(
    type: StreamEvent,
    now: number,
    contentArrived = false,
    textProgress?: {
      readonly contentIndex: number;
      readonly deltaLength?: number;
      readonly contentLength?: number;
    },
  ): boolean {
    const previousMode = this.mode;
    if (textProgress !== undefined) this.recordTextProgress(textProgress);
    switch (type) {
      case "start":
        this.mode = StreamMode.Requesting;
        this.responseCharacters = 0;
        this.displayedCharacters = 0;
        this.displayedCharactersAt = now;
        this.responseBlocks.clear();
        break;
      case "thinking_start":
        if (this.mode === StreamMode.Responding) this.startRecovery(now);
        this.mode = StreamMode.Thinking;
        this.thinkingStartedAt = now;
        this.thoughtForMs = undefined;
        break;
      case "thinking_delta":
        this.mode = StreamMode.Thinking;
        break;
      case "thinking_end":
        this.finishThinking(now);
        break;
      case "text_start":
        this.mode = StreamMode.Responding;
        break;
      case "text_delta":
      case "text_end":
        this.mode = StreamMode.Responding;
        if (contentArrived) {
          this.startRecovery(now);
          this.lastResponseAt = now;
        }
        break;
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        if (this.mode === StreamMode.Responding) this.startRecovery(now);
        this.mode = StreamMode.ToolInput;
        break;
      case "done:toolUse":
        this.mode = StreamMode.ToolUse;
        break;
      case "done":
      case "error":
        this.mode = StreamMode.Responding;
        break;
    }
    return this.mode !== previousMode;
  }

  advanceResponse(now: number): void {
    if (this.displayedCharactersAt === undefined) {
      this.displayedCharactersAt = now;
      return;
    }
    const ticks = Math.floor(
      Math.max(0, now - this.displayedCharactersAt) / RESPONSE_CATCH_UP_MS,
    );
    for (let tick = 0; tick < ticks; tick += 1) {
      this.displayedCharacters = catchUpCharacters(
        this.displayedCharacters,
        this.responseCharacters,
      );
    }
    this.displayedCharactersAt += ticks * RESPONSE_CATCH_UP_MS;
  }

  private recordTextProgress(progress: {
    readonly contentIndex: number;
    readonly deltaLength?: number;
    readonly contentLength?: number;
  }): void {
    const previous = this.responseBlocks.get(progress.contentIndex) ?? 0;
    const observed = progress.contentLength ??
      previous + Math.max(0, progress.deltaLength ?? 0);
    if (observed <= previous) return;
    this.responseBlocks.set(progress.contentIndex, observed);
    this.responseCharacters += observed - previous;
  }

  startTool(id: string, name: string, args: unknown, now: number): void {
    this.mode = StreamMode.ToolUse;
    this.tools.set(id, { name, args, startedAt: now });
    this.latestToolId = id;
  }

  endTool(id: string, now: number): void {
    const tool = this.tools.get(id);
    if (!tool) return;
    this.lastToolDuration = Math.max(0, now - tool.startedAt);
    this.lastToolUntil = now + SHORT_STATUS_WINDOW;
    this.tools.delete(id);
    if (this.latestToolId === id) this.latestToolId = [...this.tools.keys()].at(-1);
  }

  private activeIntensity(now: number): number {
    return Math.max(
      this.thinkingStartedAt === undefined ? 0 : rampIntensity(now - this.thinkingStartedAt),
      this.mode === StreamMode.Responding && this.lastResponseAt !== undefined
        ? rampIntensity(now - this.lastResponseAt) : 0,
    );
  }

  private recoveryAt(now: number): number {
    if (this.recoveryFrom === 0) return 0;
    const progress = Math.max(0, Math.min(1, (now - this.recoveryStartedAt) / RECOVERY_MS));
    return this.recoveryFrom * (1 - cssEase(progress));
  }

  private startRecovery(now: number): void {
    const active = this.activeIntensity(now);
    if (active === 0) return;
    this.recoveryFrom = Math.max(active, this.recoveryAt(now));
    this.recoveryStartedAt = now;
  }

  private finishThinking(now: number): void {
    if (this.thinkingStartedAt === undefined) return;
    this.startRecovery(now);
    this.thoughtForMs = Math.max(0, now - this.thinkingStartedAt);
    this.thoughtForUntil = now + SHORT_STATUS_WINDOW;
    this.thinkingStartedAt = undefined;
  }

  view(
    now: number,
    effort: string | undefined,
    reducedMotion = false,
  ): WorkingView {
    const activeTool = this.latestToolId ? this.tools.get(this.latestToolId) : undefined;
    const primary = `${activeToolMessage(activeTool?.name ?? "", activeTool?.args) ?? this.verb}${ELLIPSIS}`;
    const status = reducedMotion ? undefined : this.semanticStatus(now, effort);
    const elapsed = !reducedMotion && this.startedAt > 0 &&
      (status !== undefined || now - this.startedAt >= ELAPSED_TIME_DELAY)
      ? formatElapsed(now - this.startedAt)
      : undefined;
    const thinkingIntensity = !reducedMotion && this.thinkingStartedAt !== undefined
      ? rampIntensity(now - this.thinkingStartedAt) : 0;
    const stalledIntensity = !reducedMotion && this.mode === StreamMode.Responding && this.lastResponseAt !== undefined
      ? rampIntensity(now - this.lastResponseAt) : 0;
    if (reducedMotion) this.recoveryFrom = 0;
    const recoveryIntensity = reducedMotion ? 0 : this.recoveryAt(now);
    const displayedCharacters = reducedMotion
      ? this.responseCharacters
      : this.displayedCharacters;
    const tokens = Math.round(displayedCharacters / 4);
    const tokenEstimate = tokens > 0
      ? `${this.mode === StreamMode.Requesting ? "↑" : "↓"} ${tokens} tokens`
      : undefined;
    const metadata = [elapsed, tokenEstimate, status].filter(
      (item): item is string => Boolean(item),
    );
    return {
      mode: this.mode,
      primary,
      metadata,
      thinkingIntensity,
      stalledIntensity,
      recoveryIntensity,
    };
  }

  private semanticStatus(now: number, effort: string | undefined): string | undefined {
    const activeTool = this.latestToolId ? this.tools.get(this.latestToolId) : undefined;
    if (this.toolTimers && activeTool && now - activeTool.startedAt >= TOOL_TIMER_THRESHOLD) {
      return `running tool for ${formatElapsed(now - activeTool.startedAt)}`;
    }
    if (this.thinkingStartedAt !== undefined) {
      const thinkingElapsed = now - this.thinkingStartedAt;
      if (thinkingElapsed < THINKING_STATUS_DELAY) return undefined;
      const suffix = effort ? ` with ${effort} effort` : "";
      return `${thinkingLabel(thinkingElapsed)}${suffix}`;
    }
    if (this.toolTimers && this.lastToolDuration !== undefined && now <= this.lastToolUntil && this.lastToolDuration >= TOOL_TIMER_THRESHOLD) {
      return `ran tool for ${formatElapsed(this.lastToolDuration)}`;
    }
    if (this.thoughtForMs !== undefined && now <= this.thoughtForUntil) {
      return `thought for ${Math.max(1, Math.round(this.thoughtForMs / 1_000))}s`;
    }
    return undefined;
  }
}
