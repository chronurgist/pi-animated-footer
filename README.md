# pi-claude-style-spinner

A small Pi extension that gives the built-in streaming row a model-colored Claude-style spinner, shimmer, and working message. It uses only Pi's public extension API; it does not replace tools or patch Pi internals.

## Install

Load `src/index.ts` with Pi, or install this directory as a Pi package:

```sh
pi -e ./src/index.ts
```

The package manifest points Pi at `src/index.ts` automatically when installed with `pi install`.

## Configuration

The only supported configuration file is the global user file:

`~/.pi/agent/flair.json` (resolved with Pi's `getAgentDir()` API). Pi's `CONFIG_DIR_NAME` is intentionally not used to construct a project path because project-local configuration is unsupported.

There is deliberately no project-local config, command, or CRUD UI. The schema is:

```json
{
  "colors": {
    "claude": "#D77757",
    "my-provider/model-family": "#33AAFF"
  },
  "shimmers": {
    "gpt": "#767676",
    "kimi": "#85706D",
    "my-provider/model-family": "#88CCFF"
  },
  "fallback": "#A6A6A6",
  "spinnerVerbs": {
    "mode": "append",
    "verbs": ["CustomVerb"]
  },
  "toolTimers": false
}
```

`colors` and `shimmers` keys are case-insensitive substrings matched against `provider/modelId`; the longest match wins. A configured shimmer overrides the perceptually derived shimmer for that model. Values and `fallback` must be six-digit CSS hex colors; invalid entries are ignored. User colors override built-ins with the same key. Built-in families are `deepseek`, `claude`, `gemini`, `gpt`, `qwen`, `glm`, `minimax`, `gemma`, `nvidia`, and `kimi`. The example GPT and Kimi shimmer values provide stronger contrast than their automatic near-black shimmers. `spinnerVerbs.mode` may be `append` or `replace`; append adds configured verbs after the built-ins, while replace uses non-empty configured verbs only. Empty or malformed verb entries are ignored, terminal control sequences are stripped, and an empty replace list falls back to the built-ins. Set `toolTimers` to `true` to show `running tool for…` and the brief `ran tool for…` status; it defaults to `false`.

Set `PI_FLAIR_REDUCED_MOTION=1` (or `PI_REDUCED_MOTION=1`) for reduced motion. This renders one solid model-colored `●`, a solid model-colored primary message, and dim separate metadata. It starts no timer or glimmer; clock-derived elapsed and status metadata are suppressed, while incoming streaming deltas still refresh the live token estimate.

## Preview

Compare every built-in and configured model color with the production shimmer and spinner:

```sh
bun run preview
```

The preview reads the same global `flair.json`; press `Ctrl-C` to exit. When stdout is not a TTY it prints one static table instead.

## Source layout

- `src/index.ts` — Pi event wiring, model color application, refresh/cleanup lifecycle.
- `src/state.ts` — explicit turn state machine, stream modes, stable verbs, thinking/tool metadata, and tool messages.
- `src/config.ts` — built-in colors, global config loading, validation, longest-substring matching, ANSI color conversion.
- `src/animation.ts` — declarative spinner, grapheme/column shimmer, OKLab-derived colors, flash, and intensity rendering.
- `src/preview.ts` — standalone animated color/shimmer comparison tool.

Normal modes use a 100ms extension-owned clock; requesting uses 50ms. Streamed response text is shown as a smoothed `↓ N tokens` estimate (requesting uses `↑`); reduced motion uses the current length directly. The spinner follows the cosine-eased two-second `· ✢ ✳ ✶ ✻ ✽` cycle (Ghostty uses `✻` for the final frame). The primary message alone shimmers by grapheme and terminal column; metadata remains dim and separate. Tool-use flashes the whole primary message, thinking ramps after 10s, and stalled responding content suppresses the moving band after 10s.

## Development

Focused Bun tests cover color matching and the state machine; animation tests cover the color and clock/rendering primitives:

```sh
bun test
bun run typecheck
```

Production and test TypeScript are checked by `tsconfig.json`.

## Pi limitations

Pi exposes a configurable working indicator and working message, but not a public stream-mode renderer, terminal-width callback, reduced-motion preference, or theme color API for arbitrary model colors. This extension therefore owns a small TUI-only declarative refresh clock and supplies one rendered frame at a time; reduced motion deliberately owns no clock. Pi's built-in retry and compaction loaders remain unchanged; unknown/future assistant events leave the existing mode unchanged. Width budgeting is delegated to Pi's row renderer, while shimmer measurement itself is terminal-column aware.
