import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "bun:test";
import {
  activeToolMessage,
  catchUpCharacters,
  normalizeStreamEvent,
  TurnState,
} from "../src/state.ts";

describe("TurnState", () => {
  test("uses one configured verb for a turn", () => {
    const state = new TurnState(["Custom one", "Custom two"]);
    state.startTurn(0, () => 0.75);
    expect(state.view(0, undefined).primary).toBe("Custom two…");
    expect(state.view(1_000, undefined).primary).toBe("Custom two…");
  });

  test("normalizes tool-use completion without duplicating the stream protocol", () => {
    const event = {
      type: "done",
      reason: "toolUse",
      message: {} as AssistantMessage,
    } as const;
    expect(normalizeStreamEvent(event)).toBe("done:toolUse");

    const state = new TurnState();
    state.startTurn(1_000, () => 0);
    state.acceptStreamEvent(normalizeStreamEvent(event), 2_000);
    expect(state.view(2_000, undefined).mode).toBe("tool-use");
  });

  test("maps stream events to modes and status metadata", () => {
    const state = new TurnState();
    state.startTurn(0, () => 0);
    expect(state.view(0, undefined).primary).toBe("Thinking…");

    expect(state.acceptStreamEvent("thinking_start", 100)).toBe(true);
    expect(state.acceptStreamEvent("thinking_delta", 150)).toBe(false);
    expect(state.view(150, "high").mode).toBe("thinking");
    expect(state.view(399, "high").metadata).toEqual([]);
    expect(state.view(400, "high").metadata).toEqual([
      "thinking with high effort",
    ]);

    expect(state.acceptStreamEvent("text_start", 500)).toBe(true);
    expect(state.view(500, undefined).mode).toBe("responding");
    expect(state.view(500, undefined).primary).toBe("Thinking…");
  });

  test("smooths streamed character estimates without counting text_end twice", () => {
    expect(catchUpCharacters(0, 2)).toBe(2);
    expect(catchUpCharacters(0, 50)).toBe(8);
    expect(catchUpCharacters(0, 128)).toBe(50);

    const state = new TurnState();
    state.startTurn(0, () => 0);
    state.acceptStreamEvent(
      "text_delta",
      0,
      true,
      { contentIndex: 0, deltaLength: 128, contentLength: 128 },
    );
    state.acceptStreamEvent(
      "text_end",
      1,
      true,
      { contentIndex: 0, contentLength: 128 },
    );

    expect(state.view(1, undefined).metadata).toEqual([]);
    state.advanceResponse(50);
    expect(state.view(50, undefined).metadata).toEqual(["↓ 13 tokens"]);
    expect(state.view(50, undefined, true).metadata).toEqual(["↓ 32 tokens"]);
  });

  test("reduced motion refreshes live token metadata and suppresses clock statuses", () => {
    const state = new TurnState();
    state.startTurn(1_000, () => 0);
    state.acceptStreamEvent(
      "text_delta",
      1_000,
      true,
      { contentIndex: 0, deltaLength: 8, contentLength: 8 },
    );
    expect(state.view(1_000, undefined, true).metadata).toEqual(["↓ 2 tokens"]);

    state.acceptStreamEvent(
      "text_delta",
      1_001,
      true,
      { contentIndex: 0, deltaLength: 8, contentLength: 16 },
    );
    expect(state.view(1_001, undefined, true).metadata).toEqual(["↓ 4 tokens"]);

    const thinking = new TurnState();
    thinking.startTurn(1_000, () => 0);
    thinking.acceptStreamEvent("thinking_start", 1_000);
    expect(thinking.view(20_000, "high", true).metadata).toEqual([]);
    expect(thinking.view(20_000, "high", true).thinkingIntensity).toBe(0);
    thinking.acceptStreamEvent("thinking_end", 20_000);
    expect(thinking.view(20_000, "high", true).metadata).toEqual([]);
  });

  test("delays elapsed time until 16 seconds unless a normal status is present", () => {
    const state = new TurnState();
    state.startTurn(1_000, () => 0);
    expect(state.view(16_999, undefined).metadata).toEqual([]);
    expect(state.view(17_000, undefined).metadata).toEqual(["16s"]);

    const thinking = new TurnState();
    thinking.startTurn(1_000, () => 0);
    thinking.acceptStreamEvent("thinking_start", 2_000);
    expect(thinking.view(2_299, "high").metadata).toEqual([]);
    expect(thinking.view(2_300, "high").metadata).toEqual([
      "1s",
      "thinking with high effort",
    ]);
  });

  test("shows a brief thought-for status in normal motion", () => {
    const state = new TurnState();
    state.startTurn(0, () => 0.5);
    state.acceptStreamEvent("thinking_start", 1_000);
    state.acceptStreamEvent("thinking_end", 4_250);

    expect(state.view(4_250, "low").metadata).toEqual(["thought for 3s"]);
    expect(state.view(6_300, "low").metadata).toEqual([]);
  });

  test("derives messages for each built-in file tool", () => {
    const examples: Array<[string, Record<string, string>]> = [
      ["read", { path: "a.ts" }],
      ["bash", { command: "pwd" }],
      ["grep", { pattern: "needle" }],
      ["find", { pattern: "*.ts" }],
      ["ls", { path: "." }],
      ["edit", { path: "a.ts" }],
      ["write", { path: "a.ts" }],
    ];
    for (const [name, args] of examples) {
      expect(activeToolMessage(name, args)).toBeString();
    }
  });

  test("removes terminal control sequences from tool messages", () => {
    expect(
      activeToolMessage("bash", {
        command: "\u001b[2J\u001b[H\u0000echo readable",
      }),
    ).toBe("Running echo readable");
    expect(
      activeToolMessage("read", {
        path: "\u001b]0;injected title\u0007\u009d0;c1 title\u009csrc/index.ts",
      }),
    ).toBe("Reading src/index.ts");
  });

  test("ramps thinking and stalled response independently of non-content events", () => {
    const state = new TurnState();
    state.startTurn(0, () => 0);
    state.acceptStreamEvent("thinking_start", 0);
    expect(state.view(15_000, undefined).thinkingIntensity).toBe(0.5);
    expect(state.view(20_000, undefined).thinkingIntensity).toBe(1);

    state.acceptStreamEvent("text_start", 21_000);
    expect(state.view(40_000, undefined).stalledIntensity).toBe(0);
    state.acceptStreamEvent("text_delta", 22_000, true);
    expect(state.view(27_000, undefined).stalledIntensity).toBe(0);
    expect(state.view(37_000, undefined).stalledIntensity).toBe(0.5);
  });

  test("derives tool text and config-gated timer metadata", () => {
    const disabled = new TurnState();
    disabled.startTurn(10_000, () => 0.2);
    disabled.startTool("1", "read", { path: "src/index.ts" }, 10_000);
    expect(disabled.view(12_100, undefined).metadata).toEqual([]);

    const state = new TurnState(undefined, true);
    state.startTurn(10_000, () => 0.2);
    state.startTool("1", "read", { path: "src/index.ts" }, 10_000);
    expect(state.view(11_000, undefined).primary).toBe("Reading src/index.ts…");
    expect(state.view(12_100, undefined).metadata).toEqual([
      "2s",
      "running tool for 2s",
    ]);

    state.endTool("1", 13_000);
    expect(state.view(13_000, undefined).metadata).toEqual([
      "3s",
      "ran tool for 3s",
    ]);
    expect(state.view(13_000, undefined, true).metadata).toEqual([]);
  });
});
