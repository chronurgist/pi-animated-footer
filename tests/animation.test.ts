import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  animationIntervalMs,
  renderIndicator,
  renderWorkingMessage,
  segmentGraphemes,
  shimmerPosition,
  shouldRenderStreamEvent,
  spinnerGlyph,
} from "../animation.ts";
import {
  ansiColor,
  hexToOklab,
  oklabToHex,
  shimmerColor,
} from "../config.ts";
import { StreamMode, type WorkingView } from "../state.ts";

const view = (overrides: Partial<WorkingView> = {}): WorkingView => ({
  mode: StreamMode.Responding,
  primary: "A é界",
  metadata: ["12s", "thinking"],
  thinkingIntensity: 0,
  stalledIntensity: 0,
  recoveryIntensity: 0,
  ...overrides,
});

const ANSI_COLOR = /\[38;2;(\d+);(\d+);(\d+)m/g;

function colors(output: string): string[] {
  return [...output.matchAll(ANSI_COLOR)].map((match) =>
    match.slice(1, 4).join(","),
  );
}

describe("animation", () => {
  test("round-trips sRGB through OKLab and tunes Claude's observed shimmer", () => {
    expect(oklabToHex(hexToOklab("#D77757"))).toBe("#d77757");
    expect(shimmerColor("#D77757")).toBe("#f59575");
  });

  test("gives bounded colors when mapping bright, saturated colors", () => {
    const mapped = shimmerColor("#040000");
    expect(mapped).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("uses faster frames while requesting", () => {
    expect(animationIntervalMs(StreamMode.Requesting)).toBe(50);
    expect(animationIntervalMs(StreamMode.Thinking)).toBe(100);
  });

  test("throttles ordinary streaming deltas but renders mode transitions", () => {
    expect(shouldRenderStreamEvent("text_delta", false)).toBe(false);
    expect(shouldRenderStreamEvent("thinking_delta", false)).toBe(false);
    expect(shouldRenderStreamEvent("toolcall_delta", false)).toBe(false);
    expect(shouldRenderStreamEvent("text_delta", true)).toBe(true);
    expect(shouldRenderStreamEvent("thinking_delta", true)).toBe(true);
    expect(shouldRenderStreamEvent("toolcall_delta", true)).toBe(true);
    expect(shouldRenderStreamEvent("text_end", false)).toBe(true);
    expect(shouldRenderStreamEvent("text_delta", false, true)).toBe(true);
    expect(shouldRenderStreamEvent("thinking_delta", false, true)).toBe(false);
    expect(shouldRenderStreamEvent("toolcall_delta", false, true)).toBe(false);
  });

  test("cosine spinner phases and Ghostty final frame are stable", () => {
    expect(spinnerGlyph(0)).toBe("·");
    expect(spinnerGlyph(500)).toBe("✳");
    expect(spinnerGlyph(1_000)).toBe("✽");
    expect(spinnerGlyph(1_000, true)).toBe("✻");
    expect(spinnerGlyph(2_000)).toBe("·");
  });

  test("segments combining and wide graphemes by terminal columns", () => {
    const segments = segmentGraphemes("é界");
    expect(segmentGraphemes("é界")).toBe(segments);
    expect(segments.map((segment) => segment.text)).toEqual(["é", "界"]);
    expect(segments.map((segment) => segment.width)).toEqual([1, 2]);
    expect(visibleWidth("é界")).toBe(3);
  });

  test("moves the normal band right-to-left and requesting band left-to-right", () => {
    expect(shimmerPosition(0, 10, StreamMode.Responding)).toBe(20);
    expect(shimmerPosition(200, 10, StreamMode.Responding)).toBe(19);
    expect(shimmerPosition(0, 10, StreamMode.Requesting)).toBe(-10);
    expect(shimmerPosition(50, 10, StreamMode.Requesting)).toBe(-9);
  });

  test("shimmers only the primary message and flashes tool use as a whole", () => {
    const output = renderWorkingMessage(view(), "#D77757", 2_200, false);
    expect(output).toContain("12s");
    expect(output).toContain("\x1b[2m");
    expect(colors(output).length).toBe(3);
    expect(output).toContain(ansiColor("#999999", "thinking"));

    const flash = renderWorkingMessage(
      view({ mode: StreamMode.ToolUse, metadata: [] }),
      "#D77757",
      1_000,
      false,
    );
    expect(new Set(colors(flash)).size).toBe(1);
  });

  test("pulses the active thinking status and fits metadata to the row", () => {
    const dim = renderWorkingMessage(view(), "#D77757", 2_200, false);
    const bright = renderWorkingMessage(view(), "#D77757", 3_500, false);
    expect(dim).toContain(ansiColor("#999999", "thinking"));
    expect(bright).toContain(ansiColor("#B9B9B9", "thinking"));

    const fallback = renderWorkingMessage(
      view({ metadata: ["thinking with high effort"] }),
      "#D77757",
      0,
      false,
      undefined,
      11,
    );
    expect(fallback).toContain(ansiColor("#999999", "thinking"));
    expect(fallback).not.toContain("high effort");

    const omitted = renderWorkingMessage(
      view({ metadata: ["thinking"] }),
      "#D77757",
      0,
      false,
      undefined,
      10,
    );
    expect(omitted).not.toContain("thinking");

    const fitted = renderIndicator(
      view(),
      "#D77757",
      false,
      0,
      false,
      undefined,
      16,
    ).message;
    expect(fitted).toContain("12s");
    expect(fitted).not.toContain("thinking");
  });

  test("fully rendered frame colors change when model or intensity changes", () => {
    const normal = renderIndicator(view(), "#D77757", false, 0).frames[0];
    const otherModel = renderIndicator(view(), "#4D6BFE", false, 0).frames[0];
    const intense = renderIndicator(
      view({ thinkingIntensity: 1 }),
      "#D77757",
      false,
      0,
    ).frames[0];
    expect(otherModel).not.toBe(normal);
    expect(intense).not.toBe(normal);
  });

  test("recovery colors both spinner and verb without changing emphasis", () => {
    const recovered = renderIndicator(
      view({ recoveryIntensity: 0.4 }),
      "#D77757",
      false,
      2_200,
    );
    expect(colors(recovered.message)).toContain(colors(recovered.frames[0])[0]!);
    expect(recovered.message).not.toContain("\x1b[1m");
    expect(new Set(colors(recovered.message)).size).toBe(3);

    const thinking = renderWorkingMessage(
      view({ thinkingIntensity: 0.6 }),
      "#D77757",
      0,
      false,
    );
    expect(thinking).toContain("\x1b[1m");

    const stalled = renderWorkingMessage(
      view({ stalledIntensity: 0.5 }),
      "#D77757",
      0,
      false,
    );
    expect(new Set(colors(stalled)).size).toBe(2);
  });
});
