# Animated footer for Pi

A Pi extension that renders a model-colored working indicator while the agent is active. It provides:

- A Claude-style animated spinner and primary working message.
- Model-specific colors and perceptual OKLab shimmers.
- Stable, configurable working verbs.
- Tool messages such as `Reading src/index.ts…`.
- Thinking and stalled-response status metadata.
- Reduced-motion support.

## Install

Install from GitHub:

```sh
pi install git:github.com/chronurgist/pi-animated-footer
```

For local development, load the extension directly:

## Configure

Configuration is read from the global file `~/.pi/agent/flair.json`:

```json
{
  "colors": {
    "claude": "#D77757",
    "my-provider/model-family": "#33AAFF"
  },
  "shimmers": {
    "gpt": "#767676"
  },
  "fallback": "#A6A6A6",
  "spinnerVerbs": {
    "mode": "append",
    "verbs": ["CustomVerb"]
  },
  "toolTimers": false,
  "showBashToolMessage": false
}
```

Color and shimmer keys are case-insensitive substrings of `provider/modelId`; the longest match wins. Invalid colors are ignored. `spinnerVerbs.mode` is either `append` or `replace`. Set `showBashToolMessage` to `true` to show `Running <cmd>` while Bash is active.

The built-in model families are `deepseek`, `claude`, `gemini`, `gpt`, `qwen`, `glm`, `minimax`, `gemma`, `nvidia`, and `kimi`.

## Reduced motion

Set either environment variable to enable reduced motion:

```sh
PI_FLAIR_REDUCED_MOTION=1 pi
```

Reduced motion uses a solid `●`, disables the extension refresh timer and shimmer, and suppresses clock-derived status metadata.

## Preview

Preview built-in and configured colors with the production spinner:

```sh
bun run preview
```

Press `Ctrl-C` to exit the interactive preview. Non-TTY output is rendered as a static table.

## Develop

Run tests and the TypeScript check:

```sh
bun test
bun run typecheck
```
