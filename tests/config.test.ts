import { describe, expect, test } from "bun:test";
import {
  BUILTIN_COLORS,
  colorForModel,
  configuredModelColors,
  configuredSpinnerVerbs,
  FALLBACK_COLOR,
  gamutMapOklch,
  hexToOklch,
  oklabToRgb,
  oklchToHex,
  oklchToOklab,
  parseFlairConfig,
  shimmerForModel,
} from "../config.ts";
import { VERBS } from "../state.ts";

describe("model colors", () => {
  test("uses the longest case-insensitive substring", () => {
    const config = parseFlairConfig(
      JSON.stringify({
        colors: { gpt: "#111111", "gpt-5": "#222222" },
      }),
    );
    expect(colorForModel("openai", "GPT-5.2", config)).toBe("#222222");
  });

  test("combines built-ins with exact overrides and additional keys", () => {
    const config = parseFlairConfig(
      JSON.stringify({ colors: { CLAUDE: "#123456", custom: "#ABCDEF" } }),
    );
    const colors = configuredModelColors(config);
    expect(colors.claude).toBe("#123456");
    expect(colors.custom).toBe("#ABCDEF");
    expect(colors.gpt).toBe(BUILTIN_COLORS.gpt);
  });

  test("uses explicit shimmer colors with longest model matching", () => {
    const config = parseFlairConfig(
      JSON.stringify({
        shimmers: {
          gpt: "#767676",
          "gpt-5": "#888888",
          kimi: "#85706D",
          invalid: "gray",
        },
      }),
    );
    expect(shimmerForModel("openai", "GPT-5.2", config)).toBe("#888888");
    expect(shimmerForModel("moonshot", "kimi-k2", config)).toBe("#85706D");
    expect(shimmerForModel("anthropic", "claude", config)).toBe("#f59575");
    expect(config.shimmers.invalid).toBeUndefined();
  });

  test("trims and lowercases configured color and shimmer keys", () => {
    const config = parseFlairConfig(
      JSON.stringify({
        colors: { "  Custom Model  ": "#123456" },
        shimmers: { "  SHIMMER-FAMILY  ": "#654321" },
      }),
    );
    expect(colorForModel("provider", "custom model-v1", config)).toBe("#123456");
    expect(shimmerForModel("provider", "shimmer-family-v1", config)).toBe(
      "#654321",
    );
  });

  test("resolves configured spinner verbs safely", () => {
    expect(configuredSpinnerVerbs(parseFlairConfig("{}"))).toEqual(VERBS);

    const appended = parseFlairConfig(
      JSON.stringify({
        spinnerVerbs: {
          mode: "append",
          verbs: [" Custom ", "\u001b[31mSafe", "\u001b]0;title\u0007", "", 42, "  ", null],
        },
      }),
    );
    expect(configuredSpinnerVerbs(appended)).toEqual([
      ...VERBS,
      "Custom",
      "Safe",
    ]);

    const replaced = parseFlairConfig(
      JSON.stringify({
        spinnerVerbs: { mode: "replace", verbs: ["Only"] },
      }),
    );
    expect(configuredSpinnerVerbs(replaced)).toEqual(["Only"]);

    const emptyReplacement = parseFlairConfig(
      JSON.stringify({ spinnerVerbs: { mode: "replace", verbs: [] } }),
    );
    expect(configuredSpinnerVerbs(emptyReplacement)).toEqual(VERBS);
    expect(
      configuredSpinnerVerbs(
        parseFlairConfig(JSON.stringify({ spinnerVerbs: { mode: "bad" } })),
      ),
    ).toEqual(VERBS);
  });

  test("reduces chroma for negative-channel OKLCH colors", () => {
    const source = { l: 0.6, c: 0.3, h: 0 };
    const mapped = gamutMapOklch(source);
    expect(oklabToRgb(oklchToOklab(source)).g).toBeLessThan(0);
    expect(mapped).not.toBe(oklchToHex(source));
    expect(hexToOklch(mapped).c).toBeLessThan(source.c);
  });

  test("supports fallback and ignores invalid user colors", () => {
    const config = parseFlairConfig(
      JSON.stringify({
        colors: { claude: "red", custom: "#123456" },
        fallback: "#ABCDEF",
      }),
    );
    expect(colorForModel("custom", "model", config)).toBe("#123456");
    expect(colorForModel("other", "model", config)).toBe("#ABCDEF");
    expect(parseFlairConfig("not json").fallback).toBe(FALLBACK_COLOR);
    expect(parseFlairConfig("{}").toolTimers).toBe(false);
    expect(parseFlairConfig('{"toolTimers":true}').toolTimers).toBe(true);
    expect(parseFlairConfig("{}").showBashToolMessage).toBe(false);
    expect(parseFlairConfig('{"showBashToolMessage":true}').showBashToolMessage).toBe(true);
    expect(BUILTIN_COLORS.claude).toBe("#D77757");
  });
});
