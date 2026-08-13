import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  animationIntervalMs,
  renderIndicator,
  shouldRenderStreamEvent,
  shouldRunAnimationTimer,
} from "./animation.ts";
import {
  colorForModel,
  configuredSpinnerVerbs,
  type FlairConfig,
  loadFlairConfig,
  shimmerForModel,
} from "./config.ts";
import { normalizeStreamEvent, TurnState } from "./state.ts";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

type Timer = ReturnType<typeof setInterval>;

function reducedMotionEnabled(): boolean {
  const value =
    process.env.PI_FLAIR_REDUCED_MOTION ?? process.env.PI_REDUCED_MOTION;
  return value !== undefined && TRUE_VALUES.has(value.toLowerCase());
}

function modelParts(ctx: ExtensionContext): { provider: string; id: string } {
  return { provider: ctx.model?.provider ?? "", id: ctx.model?.id ?? "" };
}

function contentArrived(event: AssistantMessageEvent): boolean {
  return (
    (event.type === "text_delta" && event.delta.length > 0) ||
    (event.type === "text_end" && event.content.length > 0)
  );
}

function textProgress(event: AssistantMessageEvent): {
  readonly contentIndex: number;
  readonly deltaLength?: number;
  readonly contentLength?: number;
} | undefined {
  if (event.type === "text_end") {
    return { contentIndex: event.contentIndex, contentLength: event.content.length };
  }
  if (event.type !== "text_delta") return undefined;
  const block = event.partial.content[event.contentIndex];
  return {
    contentIndex: event.contentIndex,
    deltaLength: event.delta.length,
    contentLength: block?.type === "text" ? block.text.length : undefined,
  };
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const config: FlairConfig = await loadFlairConfig(getAgentDir());
  const state = new TurnState(configuredSpinnerVerbs(config), config.toolTimers);
  const reducedMotion = reducedMotionEnabled();
  let currentContext: ExtensionContext | undefined;
  let refreshTimer: Timer | undefined;
  let timerInterval: number | undefined;
  let animationStartedAt = 0;
  let sessionActive = false;
  let turnActive = false;
  let lastIndicatorFrame: string | undefined;

  const clearRefreshTimer = (): void => {
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    refreshTimer = undefined;
    timerInterval = undefined;
  };

  const apply = (ctx: ExtensionContext, now = Date.now()): void => {
    currentContext = ctx;
    if (ctx.mode !== "tui") {
      clearRefreshTimer();
      return;
    }
    const { provider, id } = modelParts(ctx);
    const view = state.view(now, ctx.thinkingLevel, reducedMotion);
    const elapsed = animationStartedAt === 0 ? 0 : now - animationStartedAt;
    const color = colorForModel(provider, id, config);
    const shimmer = shimmerForModel(provider, id, config, color);
    const rendered = renderIndicator(
      view,
      color,
      reducedMotion,
      elapsed,
      undefined,
      shimmer,
    );
    const indicatorFrame = rendered.frames[0];
    if (indicatorFrame !== lastIndicatorFrame) {
      ctx.ui.setWorkingIndicator({ frames: [...rendered.frames] });
      lastIndicatorFrame = indicatorFrame;
    }
    ctx.ui.setWorkingMessage(rendered.message);
  };

  const ensureRefreshTimer = (ctx: ExtensionContext, now: number): void => {
    if (
      !shouldRunAnimationTimer(
        ctx.mode === "tui",
        sessionActive,
        turnActive,
        reducedMotion,
      )
    ) {
      clearRefreshTimer();
      return;
    }
    const mode = state.view(now, ctx.thinkingLevel).mode;
    const nextInterval = animationIntervalMs(mode, reducedMotion);
    if (nextInterval === timerInterval && refreshTimer !== undefined) return;
    clearRefreshTimer();
    if (nextInterval === undefined || !sessionActive || !turnActive) return;
    timerInterval = nextInterval;
    refreshTimer = setInterval(() => {
      const activeContext = currentContext;
      if (
        !sessionActive ||
        !turnActive ||
        activeContext === undefined ||
        activeContext.mode !== "tui"
      ) {
        clearRefreshTimer();
        return;
      }
      const now = Date.now();
      state.advanceResponse(now);
      apply(activeContext, now);
      ensureRefreshTimer(activeContext, now);
    }, nextInterval);
  };

  const refresh = (ctx: ExtensionContext, now = Date.now()): void => {
    apply(ctx, now);
    ensureRefreshTimer(ctx, now);
  };

  const clearWorkingState = (ctx: ExtensionContext): void => {
    clearRefreshTimer();
    currentContext = undefined;
    turnActive = false;
    animationStartedAt = 0;
    lastIndicatorFrame = undefined;
    state.reset();
    if (ctx.mode === "tui") {
      ctx.ui.setWorkingMessage();
      ctx.ui.setWorkingIndicator();
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    clearRefreshTimer();
    sessionActive = true;
    turnActive = false;
    state.reset();
    animationStartedAt = 0;
    lastIndicatorFrame = undefined;
    currentContext = ctx;
    if (ctx.mode === "tui") refresh(ctx);
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (!sessionActive) return;
    const now = Date.now();
    turnActive = true;
    state.startTurn(now);
    animationStartedAt = now;
    refresh(ctx, now);
  });

  pi.on("message_update", async (event, ctx) => {
    if (!sessionActive || event.message.role !== "assistant") return;
    const streamEvent = event.assistantMessageEvent;
    const type = normalizeStreamEvent(streamEvent);
    const modeChanged = state.acceptStreamEvent(
      type,
      Date.now(),
      contentArrived(streamEvent),
      textProgress(streamEvent),
    );
    if (shouldRenderStreamEvent(type, modeChanged, reducedMotion)) refresh(ctx);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!sessionActive) return;
    state.startTool(event.toolCallId, event.toolName, event.args, Date.now());
    refresh(ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!sessionActive) return;
    state.endTool(event.toolCallId, Date.now());
    refresh(ctx);
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    if (sessionActive) refresh(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    if (sessionActive) refresh(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (sessionActive) {
      turnActive = false;
      clearWorkingState(ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    sessionActive = false;
    turnActive = false;
    clearWorkingState(ctx);
  });
}
