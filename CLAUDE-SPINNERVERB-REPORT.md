# Claude Code spinner and verb animation

This document describes the working-indicator behavior observed in Claude Code 2.1.229 on macOS arm64. It is written as an implementation reference for recreating the behavior from scratch.

The report intentionally omits Claude Code's full default verb list. The selection rules and rendering behavior are the relevant contract.

## Overview

Claude Code renders a working-indicator row composed of:

1. A spinner glyph.
2. A status message, usually a randomly selected verb followed by an ellipsis.
3. Optional elapsed-time, token-count, thinking, retry, compaction, or tip text.

The spinner and message are driven by the same stream-mode state. The message animation is a moving color band, not a brightness change applied independently to each character. The primary verb message and its status suffixes are separate render values: suffix changes do not reselect the verb.

## State model

A from-scratch implementation needs the following state:

```text
mode                    One of tool-input, tool-use, requesting, responding, thinking.
defaultVerb             One randomly selected verb for the current spinner instance.
overrideMessage         Optional explicit message, such as a compaction status.
overrideColor           Optional replacement for the base message color.
overrideShimmerColor    Optional replacement for the moving-band color.
spinnerSuffix           Optional caller-provided status, such as hook progress.
thinkingStatus          null, "thinking", or a completed thinking duration in milliseconds.
effortSuffix            Derived text, usually " with <level> effort" or empty.
turnEffort              Requested effort for the current turn.
turnModel               Model used to resolve the current effort label.
hasActiveTools          Whether a tool is currently running.
verbose                 Whether elapsed-time metadata is requested.
retryStatus             Optional retry/error state that replaces the normal row.
isCompacting             Whether compaction is active.
compactingStartTime      Start time for the compaction progress indicator.
compactingHintText       Optional dim text shown below the compaction row.
spinnerTip              Optional secondary tip text.
responseLength          Number of streamed response characters or equivalent progress.
loadingStartTime        Start of the current request.
prefersReducedMotion    Accessibility setting.
```

Claude Code stores this state in a spinner store. The bundled implementation uses the minified functions `j9a`, `z9a`, and `aQf` for state creation, state access, and rendering.

### Verb configuration

The configuration shape is:

```json
{
  "spinnerVerbs": {
    "mode": "append",
    "verbs": ["CustomVerb"]
  }
}
```

The selection rules are:

- If `spinnerVerbs` is absent, use the built-in pool.
- If `mode` is `replace` and `verbs` is non-empty, use only `verbs`.
- If `mode` is `replace` and `verbs` is empty, fall back to the built-in pool.
- If `mode` is `append`, concatenate the built-in pool and `verbs`.
- Select one item uniformly at random.
- Keep that selection stable while the spinner renders. Do not select a new verb on every frame.

The bundled selector uses the equivalent of:

```ts
function chooseVerb(verbs: string[]): string {
  return verbs[Math.floor(Math.random() * verbs.length)] ?? "Working";
}
```

The default verb is selected when the spinner state is materialized and again when spinner overrides are reset. A task's active form or subject can take precedence over the selected verb while that task is displayed.

### Message precedence

The displayed message is resolved in this order:

```ts
const message = `${
  overrideMessage ??
  activeTask?.activeForm ??
  activeTask?.subject ??
  defaultVerb
}…`;
```

If no override or active task exists, the selected verb is used. Claude Code uses the Unicode ellipsis character (`…`), not three ASCII periods.

## Spinner verb line and suffix behavior

The complete working-indicator line has two independent layers:

1. The **primary message**: a spinner glyph followed by the resolved verb, task text, or override message.
2. The **auxiliary group**: optional suffixes and progress metadata rendered after the message.

The general shape is:

```text
<spinner> <primary message> (<spinner suffix> · <elapsed> · <tokens> · <status>)
```

Every item is optional. The order is fixed when multiple items are present. Parentheses and separators are dimmed; the active thinking status can retain the thinking color. Illustrative lines are:

```text
✳ Thinking…
✳ Thinking… (thinking)
✳ Thinking… (thinking with high effort)
✳ Thinking… (17s · ↓ 128 tokens · thinking with high effort)
✳ Thinking… (running stop hooks… 1/2 · 17s)
```

The glyph, selected verb, colors, and exact metadata depend on mode, theme, width, and current state. The examples intentionally do not enumerate the default verb list.

### Thinking-status color pulse

The active thinking status does not use the primary message color directly. In normal motion it uses a delayed grayscale pulse, then gradually blends toward the warning color as thinking intensity rises.

The effective helper in Claude Code 2.1.229 is:

```ts
function thinkingStatusColor(
  elapsedMs: number,
  thinkingIntensity: number,
  warningColor?: Rgb,
): Rgb {
  const pulse = elapsedMs < 3_000
    ? 0
    : (Math.sin(
        ((elapsedMs - 3_000) / 1_000) * Math.PI * 2 / 2,
      ) + 1) / 2;

  const neutral = interpolateRgb(
    { r: 153, g: 153, b: 153 },
    { r: 185, g: 185, b: 185 },
    pulse,
  );

  return warningColor === undefined || thinkingIntensity === 0
    ? neutral
    : interpolateRgb(neutral, warningColor, thinkingIntensity);
}
```

The grayscale pulse runs from approximately `rgb(153, 153, 153)` to `rgb(185, 185, 185)` with a two-second period after a three-second delay. At low thinking intensity the status therefore appears to breathe between dim gray and brighter gray. After the thinking-intensity ramp begins, the pulse color is blended toward the theme warning color; at full intensity the warning color dominates.

This pulse applies to the active `thinking`, `still thinking`, `thinking more`, `thinking some more`, and `almost done thinking` status labels, including their effort suffixes. It does not replace the primary message shimmer. Other semantic statuses use their own dim or warning styling.

When only the active thinking status fits, Claude renders the parentheses as part of the status item so that the status color remains active while the parentheses stay dim. When other metadata is present, the group parentheses and separators remain dimmed independently.

### Status resolution

The renderer derives at most one semantic status item for each frame. The precedence is:

1. `tool-running` when tool-call timers are enabled, a tool is active, and it has run for at least two seconds.
2. `tool-done` when tool-call timers are enabled, no tool is active, the previous tool ran for at least two seconds, and no thinking status is active.
3. `thinking` while `thinkingStatus` is the string `thinking` and no tool is active.
4. `thought-for` when `thinkingStatus` is a completed duration.
5. No status item.

The tool timer is gated by the `tengu_shining_fractals` feature flag in `aQf`; it is not a guaranteed part of every installation. Its text is:

```text
running tool for <duration>
ran tool for <duration>
```

The active timer starts when an active tool window begins. A completed timer is shown only when the tool window lasted at least two seconds.

### Thinking status and effort suffix

When the stream enters `thinking`, the renderer records the start of a thinking burst and sets `thinkingStatus` to `thinking`. When the stream leaves `thinking`, it replaces that value with the measured duration for up to two seconds, then clears it. The active thinking label is bucketed as follows:

| Thinking duration | Status label |
| --- | --- |
| Less than 10 seconds | `thinking` |
| 10–20 seconds | `still thinking` |
| 20–30 seconds | `thinking more` |
| 30–45 seconds | `thinking some more` |
| At least 45 seconds | `almost done thinking` |

The post-thinking status is `thought for Ns`. `N` is the rounded duration in seconds, with a minimum of one second. It remains available for approximately two seconds after thinking ends.

Effort is appended only to an active thinking status. The effective behavior is:

```ts
const effortSuffix = resolvedEffort === undefined
  ? ""
  : ` with ${resolvedEffort} effort`;

const statusText = `${thinkingLabel}${effortSuffix}`;
```

The bundled helper resolves the turn's effort against the turn model and falls back to the configured effort setting. It normalizes the value before display; the report does not depend on a particular exhaustive effort-level list. If no valid effort resolves, the suffix is empty. The source passes this value as `effortSuffix` to `jXf`, so it is not part of the selected verb and is not included in the shimmer calculation.

For example, with a resolved effort label of `high`, the suffix is exactly ` with high effort`, producing a status item such as:

```text
(thinking with high effort)
```

The effort suffix is not added to `thought for Ns`, `running tool for`, or `ran tool for`.

### Optional metadata items

The auxiliary group can contain these values:

| Item | Display behavior |
| --- | --- |
| `spinnerSuffix` | Caller-provided text, dimmed and placed first. |
| Elapsed time | Compact elapsed duration, excluding paused time. |
| Token estimate | An arrow plus a compact token count, for example `↓ 128 tokens`. |
| Semantic status | Thinking, post-thinking, or tool-timer text as described above. |

Elapsed time is eligible when verbose mode is enabled, a semantic status exists, output tokens are nonzero, or the request has run for more than 16 seconds. It is still omitted if the complete item does not fit. The token estimate is eligible when the estimated response token count is greater than zero and the item fits.

The arrow does **not** indicate input tokens. Claude uses one response-length estimate and chooses the arrow independently from the stream mode:

```ts
const arrow = mode === "requesting" ? "↑" : "↓";
const displayedTokens = Math.round(displayedCharacters / 4);
```

The same `displayedTokens` value is used for both arrows. There is no `message.length / 4` or whole-context-token calculation in this renderer.

The token estimate is intentionally smoothed. Every 50 ms, the renderer advances a displayed character count toward the streamed `responseLength` using the exact catch-up rules:

```ts
const remainder = responseLength - displayedCharacters;
const increment = remainder < 70
  ? 3
  : remainder < 200
    ? Math.max(8, Math.ceil(remainder * 0.15))
    : 50;
```

Reduced-motion mode uses the current response length directly. Claude formats the resulting count with compact `Intl.NumberFormat` settings, lowercased afterward; examples are `1.2k`, `98.0k`, and `1.2m`.

This keeps the suffix moving without jumping on every stream delta.

### Width, punctuation, and fallback rules

The renderer measures the primary message and every candidate status in terminal columns. It then builds the auxiliary group in this order:

```ts
const items = [
  spinnerSuffix,
  fits(elapsed) ? elapsed : null,
  fits(tokens) ? tokens : null,
  fits(status) ? status : null,
].filter(Boolean);
```

The actual implementation applies the same idea with a fixed row budget and visible-width measurements:

- The status is considered first for width budgeting.
- If a thinking label with an effort suffix does not fit, it falls back to plain `thinking` when that fits. If neither fits, the status is omitted.
- Elapsed time and token count are independently omitted when their text plus separators would exceed the available columns.
- Items are joined with the exact separator ` · `.
- When the only item is an active thinking status under normal motion, the renderer emits it as one parenthesized item, such as `(thinking with high effort)`.
- Otherwise, the complete group is enclosed in dim parentheses, such as `(17s · ↓ 128 tokens · thinking with high effort)`.
- In the expanded task view, the source suppresses elapsed, token, and semantic-status items; a caller-provided `spinnerSuffix` remains independently eligible.

The suffix group is laid out beside the primary message and can wrap with the row. A reimplementation should use terminal-column width and grapheme segmentation for both message and metadata rather than JavaScript string length.

### Hook and external suffixes

`spinnerSuffix` is supplied by the caller; it is not generated by the verb selector. In the main UI call site, the value named `QQe` summarizes `Stop` and `SubagentStop` hook progress before passing it to `VVa` and then to `jXf`.

The observed hook-summary rules are:

- A hook-provided `statusMessage` is displayed with a Unicode ellipsis. With one hook it is `<statusMessage>…`; with multiple hooks it is `<statusMessage>… <completed>/<total>`.
- Without a custom status message, one stop hook is `running stop hook`.
- Without a custom status message, one subagent-stop hook is `running subagent stop hook`.
- Multiple hooks use `running stop hooks… <completed>/<total>`.
- Once the matching `stop_hook_summary` arrives, the suffix is cleared.

Because this value is the first auxiliary item, examples may look like:

```text
✻ Working… (running stop hooks… 1/2 · 4s)
✻ Working… (Formatting files… · 4s)
```

The same renderer can accept other caller-provided suffix text; hook progress is the observed call site, not a restriction on the field.

### Replacement and secondary rows

Some states replace or extend the normal verb row instead of merely adding a suffix:

- **Retrying:** when `retryStatus` is present, `jXf` does not render the normal spinner, shimmer, or suffix group. The retry renderer shows an error-colored title and a countdown, generally in the form `Retrying in <duration> · attempt <n>/<max>`. A stalled retry instead says `Waiting for API response · will retry in <duration> · check your network`. Rate-limit retries can include a reset time.
- **Compacting:** the primary message is overridden with `Compacting conversation`. When a compaction hint exists, it is rendered as a separate dim line below the primary row. If the terminal is wide enough, a compacting progress bar and percentage are rendered below the row; the percentage approaches 95% rather than claiming completion:

  ```ts
  const progress = Math.min(
    95,
    Math.round((1 - Math.exp(-elapsedSeconds / 90)) * 100),
  );
  ```

- **Tips:** when spinner tips are enabled, a configured tip or a built-in contextual tip can appear below the row as `Tip: <text>`. The observed defaults become eligible after about 30 seconds (`/btw`) and 30 minutes (`/clear`), subject to the user's tip settings, prior `/btw` usage, and stalled-response state.

These rows are separate from the primary verb selection. A from-scratch implementation should keep replacement messages and secondary rows in the same render state rather than encoding them as new verbs.

## Stream modes and call sites

The stream parser emits mode changes through an `onSetStreamMode` callback. The main renderer receives that callback as `pt.main.setMode`.

Observed transitions include:

| Event or condition | Mode |
| --- | --- |
| Request begins | `requesting` |
| Thinking content block begins | `thinking` |
| Text content block begins | `responding` |
| Tool-use input begins | `tool-input` |
| Assistant message stops after producing a tool call | `tool-use` |

The relevant parser behavior is equivalent to:

```ts
if (event.type === "stream_request_start") {
  setMode("requesting");
}

if (event.type === "content_block_start") {
  switch (event.content_block.type) {
    case "thinking":
    case "redacted_thinking":
      setMode("thinking");
      break;
    case "text":
      setMode("responding");
      break;
    case "tool_use":
      setMode("tool-input");
      break;
  }
}

if (event.type === "message_stop") {
  setMode("tool-use");
}
```

The renderer consumes the mode in `aQf`, then passes derived animation values to `jXf`, `xUe`, and `xjr`:

```text
aQf  Resolves settings, message, colors, tips, and mode-specific values.
 └─ jXf  Builds the complete working-indicator row.
     ├─ xUe  Renders the spinner glyph.
     └─ xjr  Renders the verb/status message and moving shimmer.
```

## Animation clock

Claude Code uses a timer-driven animation hook. The effective update interval is:

```ts
const intervalMs = prefersReducedMotion
  ? null
  : mode === "requesting"
    ? 50
    : 100;
```

Normal modes update approximately every 100 ms. `requesting` mode updates approximately every 50 ms. The timer value is used as elapsed animation time; rendering is declarative and recalculates the spinner and message from that value.

## Spinner animation

The default spinner frames are:

```text
· ✢ ✳ ✶ ✻ ✽
```

When the terminal is detected as Ghostty, the final frame is replaced with a second `✻`.

The bundled code defines a two-second eased cycle. The effective frame index is equivalent to:

```ts
function spinnerFrame(elapsedMs: number, frames: string[]): string {
  const phase = (1 - Math.cos((2 * Math.PI * elapsedMs) / 2000)) / 2;
  const index = Math.round(phase * (frames.length - 1));
  return frames[index % frames.length] ?? frames[0] ?? "·";
}
```

This produces a smooth forward-and-back motion rather than a uniform linear rotation:

```text
0 → 1 → 2 → 3 → 4 → 5 → 4 → 3 → 2 → 1 → 0
```

The bundled code also constructs a forward-plus-reverse frame array, but the eased index is bounded by the base frame count. The visible behavior is therefore the cosine-eased sequence above.

### Reduced-motion behavior

When reduced motion is enabled, Claude Code does not advance the normal spinner or glimmer. It renders a solid `●` and applies a slow color breathing effect. The breathing period is approximately two seconds:

```ts
const brightness = 1 - (1 - Math.cos((2 * Math.PI * elapsedMs) / 2000)) / 2;
```

The dot uses the message color, blends toward black, and becomes bold while thinking intensity is at least 0.5.

## Verb shimmer animation

The normal verb shimmer is a three-column color band that travels from right to left across the message.

The implementation must measure the message in terminal columns and segment it by grapheme cluster. Do not use JavaScript UTF-16 string indexes for this calculation. This matters for emoji, combining marks, and other multi-code-point characters.

Let:

```text
W = visible terminal width of the message
T = elapsed animation time in milliseconds
```

For normal modes, the animation advances one column every 200 ms:

```ts
const step = Math.floor(T / 200);
const cycleWidth = W + 20;
const glimmerIndex = W + 10 - (step % cycleWidth);
```

The band covers the glimmer index and its immediate neighbors:

```text
glimmerIndex - 1, glimmerIndex, glimmerIndex + 1
```

The ten-column margin causes the band to begin offscreen on the right and finish offscreen on the left. The band is initially invisible, enters from the right, crosses the message, exits on the left, and then repeats.

For `requesting` mode, the animation runs in the opposite direction and advances every 50 ms:

```ts
const step = Math.floor(T / 50);
const cycleWidth = W + 20;
const glimmerIndex = (step % cycleWidth) - 10;
```

This makes the band enter from the left and leave on the right.

### Grapheme-aware band application

A segment is rendered with the shimmer color when it overlaps the three-column band. A from-scratch implementation can use logic equivalent to:

```ts
function colorMessage(
  segments: Array<{ text: string; start: number; width: number }>,
  messageWidth: number,
  glimmerIndex: number,
  baseColor: Color,
  shimmerColor: Color,
): ColoredSegment[] {
  const bandStart = Math.max(0, glimmerIndex - 1);
  const bandEnd = glimmerIndex + 1;
  let column = 0;

  return segments.map(({ text, width }) => {
    const segmentStart = column;
    const segmentEnd = column + width;
    column = segmentEnd;

    const beforeBand = segmentEnd <= bandStart;
    const afterBand = segmentStart > bandEnd;
    return {
      text,
      color: beforeBand || afterBand ? baseColor : shimmerColor,
    };
  });
}
```

The actual renderer preserves grapheme segments and visible widths rather than slicing the message into individual code units.

### Colors

The renderer resolves two theme keys:

```text
claude         Base message color.
claudeShimmer  Moving-band color.
```

The default RGB theme palette observed in the binary contains:

```text
claude:        rgb(215, 119, 87)
claudeShimmer: rgb(245, 149, 117)
```

Other bundled palettes provide different values. Use theme lookup rather than hard-coding these RGB values if the implementation supports themes. System-spinner and permission states use separate blue theme keys.

## Additional mode-specific effects

The shimmer is not the only animation in the renderer.

### Tool-use flash

In `tool-use` mode, Claude Code applies a whole-message flash between the base and shimmer colors. The opacity follows a two-second sinusoidal cycle:

```ts
const opacity = (Math.sin((elapsedMs / 1000) * Math.PI) + 1) / 2;
```

The flash is applied to the whole message rather than to the moving three-column band.

### Thinking intensity

When the mode is `thinking`, Claude Code records the beginning of the current thinking burst. After 10 seconds, it increases thinking intensity linearly until it reaches 1.0 at 20 seconds:

```ts
const thinkingIntensity = clamp((thinkingElapsedMs - 10_000) / 10_000, 0, 1);
```

The spinner and message gradually blend toward a warning/error color. The message becomes warning-colored or bold after the intensity passes the midpoint.

The thinking status text changes with elapsed thinking time:

| Thinking duration | Status |
| --- | --- |
| Less than 10 seconds | `thinking` |
| 10–20 seconds | `still thinking` |
| 20–30 seconds | `thinking more` |
| 30–45 seconds | `thinking some more` |
| At least 45 seconds | `almost done thinking` |

When thinking ends, Claude Code briefly displays a `thought for Ns` status before clearing it.

### Stalled-response intensity

Claude Code tracks response length. If no new response content arrives for more than 10 seconds, it treats the response as stalled and ramps a separate intensity over the following 10 seconds. This intensity drives a red tint and suppresses the moving glimmer while the response is stalled.

## From-scratch implementation checklist

Implement the behavior in this order:

1. Define the spinner modes and the spinner state.
2. Resolve the verb pool using `append` or `replace` semantics.
3. Select one verb when the spinner state starts or resets.
4. Resolve the message using override, task, and verb precedence.
5. Add the Unicode ellipsis.
6. Track `spinnerSuffix`, thinking status, effort suffix, tool windows, elapsed time, and token progress separately from the verb.
7. Resolve semantic-status precedence: tool timer, completed tool timer, thinking, post-thinking duration, or none.
8. Append ` with <effort> effort` only to an active thinking label.
9. Build the auxiliary group with fixed ordering, dim separators, width checks, and the thinking fallback.
10. Create a 100 ms animation clock, with a 50 ms clock for `requesting` mode.
11. Render the spinner using a two-second cosine-eased frame index.
12. Measure message width in terminal columns.
13. Segment the message by grapheme cluster.
14. Move a three-column shimmer band across the message with a 20-column total travel margin.
15. Reverse the band direction in `requesting` mode.
16. Add reduced-motion, tool-use flash, thinking intensity, stalled-response, retry, compaction, and tip handling.
17. Route stream events into mode changes before rendering each frame.

## Commands used to surface the implementation

The following commands inspect the embedded JavaScript in the Claude Code 2.1.229 binary. They use `rg` in binary-as-text mode (`-a`) and report byte offsets (`-b`).

### Resolve the executable

```bash
CLAUDE_LINK="$(command -v claude)"
CLAUDE_BIN="$CLAUDE_LINK"
if [ -L "$CLAUDE_LINK" ]; then CLAUDE_BIN="$(readlink "$CLAUDE_LINK")"; fi
file "$CLAUDE_BIN"
"$CLAUDE_LINK" --version
```

For the inspected installation, the link resolves to:

```text
/Users/nths/.local/bin/claude
→ /Users/nths/.local/share/claude/versions/2.1.229
```

### Find the verb and renderer functions

```bash
rg -a -b -o -m 1 'function qtr\(\)' "$CLAUDE_BIN"
rg -a -b -o -m 1 'function j9a\(\)' "$CLAUDE_BIN"
rg -a -b -o -m 1 'function xjr\(' "$CLAUDE_BIN"
rg -a -b -o -m 1 'function xUe\(' "$CLAUDE_BIN"
rg -a -b -o -m 1 'function jXf\(' "$CLAUDE_BIN"
rg -a -b -o -m 1 'function zXf\(' "$CLAUDE_BIN"
rg -a -b -o -m 1 'function tp\(' "$CLAUDE_BIN"
rg -a -b -o -m 1 'function aQf\(' "$CLAUDE_BIN"
```

Observed offsets for version 2.1.229:

```text
272960623:function qtr()
272963218:function j9a()
273303466:function xjr(
273308576:function xUe(
273313906:function jXf(
273320349:function zXf(
260512468:function tp(
273322790:function aQf(
```

### Find the animation helpers

```bash
rg -a -b -o -m 1 'yut=_c\(\(\)=>\{' "$CLAUDE_BIN"
rg -a -b -o -m 1 'function YSv\(' "$CLAUDE_BIN"
rg -a -b -o -m 1 'function XSv\(' "$CLAUDE_BIN"
rg -a -b -o -m 1 'function QSv\(' "$CLAUDE_BIN"
```

Observed offsets:

```text
272877491:yut=_c(()=>{
273313468:function YSv(
273313713:function XSv(
273313771:function QSv(
```

### Find spinner-line suffix helpers

These searches surface the state machine and display helpers used for the suffix group:

```bash
rg -a -b -o -m 1 'function RXf\(' "$CLAUDE_BIN"
rg -a -b -o -m 1 'function xXf\(' "$CLAUDE_BIN"
rg -a -b -o -m 1 'function IXf\(' "$CLAUDE_BIN"
rg -a -b -o -m 1 'function PXf\(' "$CLAUDE_BIN"
rg -a -b -o -m 1 'function OXf\(' "$CLAUDE_BIN"
rg -a -b -o -m 1 'function JSv\(' "$CLAUDE_BIN"
rg -a -b -o -m 1 'function jXf\(' "$CLAUDE_BIN"
rg -a -b -o -m 1 'function e5n\(' "$CLAUDE_BIN"
rg -a -b -o -m 1 'function VVa\(' "$CLAUDE_BIN"
rg -a -b -o -m 1 'function eTt\(' "$CLAUDE_BIN"
rg -a -b -o -m 1 'let QQe=' "$CLAUDE_BIN"
rg -a -b -o -m 10 'effortSuffix|turnEffort|turnModel|spinnerSuffix|thinkingStatus' "$CLAUDE_BIN"
rg -a -b -o -m 5 -P '.{0,120}hook_progress.{0,600}' "$CLAUDE_BIN"
```

Observed offsets for version 2.1.229:

```text
273311604:function RXf(
273311706:function xXf(
273312082:function IXf(
273312705:function PXf(
273312883:function OXf(
273313539:function JSv(
273313906:function jXf(
273318304:function e5n(
273321706:function VVa(
260651032:function eTt(
280968028:let QQe=
```

`RXf` and `xXf` track tool and thinking windows. `IXf` selects the semantic status, `JSv` buckets thinking duration, `jXf` assembles the row, `zXf` selects the token arrow from the stream mode, `tp` formats the compact token count, `e5n` renders retry states, `eTt` creates the effort suffix, and `QQe` is the observed hook-progress suffix call site. The offsets are version-specific.

A verification pass against the installed Claude Code 2.1.231 binary found the same relevant implementation at these offsets: `jXf` 273313906, `zXf` 273320349, `tp` 260512468, and `aQf` 273322790. The token value is derived from `responseLengthRef`, not from the submitted message or full context.

To print the complete suffix renderer and its nearby constants:

```bash
dd if="$CLAUDE_BIN" bs=1 skip=273311604 count=13000 2>/dev/null | strings -n 1
```

### Find configuration and accessibility keys

```bash
rg -a -b -o -m 3 'spinnerVerbs|spinnerTipsEnabled|prefersReducedMotion' "$CLAUDE_BIN"
```

The settings schema is near the `spinnerVerbs` match. The renderer reads `prefersReducedMotion` before selecting the animation clock.

### Find stream-mode routing

```bash
rg -a -b -o -m 8 -P '.{0,160}onSetStreamMode.{0,320}' "$CLAUDE_BIN"
rg -a -b -o -m 10 -P 'case"(thinking_delta|text_delta|content_block_start|message_stop)".{0,600}' "$CLAUDE_BIN"
rg -a -b -o -m 5 'stream_mode|type:"spinner_mode"' "$CLAUDE_BIN"
```

Useful observed locations include:

```text
271777495:onSetStreamMode
271778414:case"content_block_start"
268232597:onSetStreamMode:(Ir)=>dr.push({type:"spinner_mode",mode:Ir})
280931241:onSetStreamMode:pt.main.setMode
281335500:stream_mode
```

### Find the theme colors

```bash
rg -a -b -o -m 4 -P '.{0,40}claude:"rgb\([^)]*\)".{0,120}' "$CLAUDE_BIN"
```

The first RGB palette reported for the inspected version contains the base and shimmer values documented above.

### Print a byte window around a known function

Use this when a match gives an offset and the surrounding bundled source is needed:

```bash
dd if="$CLAUDE_BIN" bs=1 skip=272960623 count=12000 2>/dev/null | strings -n 1
```

For the renderer and animation implementation:

```bash
dd if="$CLAUDE_BIN" bs=1 skip=273303466 count=22000 2>/dev/null | strings -n 1
```

Byte offsets are version-specific. Always rerun the `rg -a -b` searches after upgrading Claude Code instead of reusing these offsets.

## Evidence map

| Behavior | Bundled function or data | Version 2.1.229 offset |
| --- | --- | ---: |
| Verb configuration merge | `qtr` | 272960623 |
| Spinner state and verb reset | `j9a` | 272963218 |
| Terminal-dependent spinner frames | `yut` | 272877491 |
| Glimmered message rendering | `xjr` | 273303466 |
| Spinner glyph rendering | `xUe` | 273308576 |
| Spinner frame calculation | `YSv` | 273313468 |
| Tool-use flash calculation | `XSv` | 273313713 |
| Thinking-status pulse color | `QSv` | 273313771 |
| Tool/thinking window state | `RXf`, `xXf` | 273311604, 273311706 |
| Semantic suffix selection | `IXf` | 273312082 |
| Thinking intensity | `PXf` | 273312705 |
| Stalled-response intensity | `OXf` | 273312883 |
| Thinking status labels | `JSv` | 273313539 |
| Complete indicator row and suffix layout | `jXf` | 273313906 |
| Token arrow selection | `zXf` | 273320349 |
| Compact token formatting | `tp` | 260512468 |
| Retry row | `e5n` | 273318304 |
| Message and settings resolution | `aQf` | 273322790 |
| Effort suffix resolution | `eTt` | 260651032 |
| Hook-progress suffix call site | `QQe` | 280968028 |
| Stream event to mode mapping | `eka` | 271777495 |
| Main renderer mode callback | `pt.main.setMode` | 280931241 |
| Theme color definitions | `claude` and `claudeShimmer` | 263332904 |

## Limitations

- Claude Code is distributed as a bundled native executable. The function names above are minified bundle names, not stable public APIs.
- Byte offsets can change between releases, even when behavior does not.
- Theme values vary by palette and terminal mode.
- This report describes the observed interactive renderer. It does not describe headless output formats.
- The full default verb list is intentionally not included.
