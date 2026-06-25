# Public README and Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reposition Open Web Agent publicly as a composable web-agent runtime and add a matching generated banner to the repository README.

**Architecture:** The implementation is documentation-only plus one generated raster asset. The README will distinguish the stable runtime from its interchangeable agent, model, and browser boundaries, while accurately listing what is built in today. A 16:9 banner will visualize the same composition model and the existing TUI screenshot will move into a product-preview section.

**Tech Stack:** Markdown, PNG image asset, built-in image generation, Bun TypeScript typecheck

---

## File Structure

- Create `docs/assets/open-web-agent-runtime-banner.png`: generated 16:9 public banner.
- Modify `README.md`: new positioning, extension-point overview, current-support matrix, product preview, existing quick start, and documentation links.

### Task 1: Generate and validate the runtime banner

**Files:**
- Create: `docs/assets/open-web-agent-runtime-banner.png`

- [ ] **Step 1: Generate the banner**

Use the built-in image generator with this production prompt:

```text
Use case: ads-marketing
Asset type: GitHub repository README hero banner
Primary request: Create a polished technical banner for an open-source project named Open Web Agent. It is a composable runtime where developers can bring their own agent, model, and browser environment.
Scene/backdrop: near-black abstract technical space with subtle depth, restrained cyan and violet illumination, no physical room or landscape
Subject: one luminous runtime core connected by thin orbital paths to three distinct modular nodes labeled AGENT, MODEL, and BROWSER
Style/medium: crisp editorial technology illustration, premium developer-tool branding, clean geometric forms, precise lines, minimal and sophisticated
Composition/framing: 16:9 wide banner; title and tagline have clear hierarchy; central runtime core is the visual anchor; surrounding nodes remain readable at GitHub README scale; ample negative space
Lighting/mood: controlled luminous glow, confident, open, extensible, technical
Color palette: near-black, charcoal, cyan, restrained violet, small white highlights
Text (verbatim): "OPEN WEB AGENT"
Text (verbatim): "BRING YOUR OWN AGENT, MODEL, AND BROWSER."
Text (verbatim): "AGENT"
Text (verbatim): "MODEL"
Text (verbatim): "BROWSER"
Constraints: exact text only; all text spelled correctly; no vendor logos; no robot; no human figure; no browser screenshot; no code screenshot; no watermark; no additional marketing copy
Avoid: generic AI brain imagery, dense circuitry, excessive neon, illegible microtext, fake logos, clutter
```

- [ ] **Step 2: Copy the generated output into the repository**

Copy the selected generated bitmap from the image generator output directory to:

```text
docs/assets/open-web-agent-runtime-banner.png
```

Do not overwrite `docs/assets/open-web-agent-tui-browser.png`.

- [ ] **Step 3: Verify dimensions and inspect the asset**

Run:

```bash
sips -g pixelWidth -g pixelHeight docs/assets/open-web-agent-runtime-banner.png
```

Expected: a 16:9 image, preferably `1600 × 900`. If the generated output differs, resize it proportionally to exactly 1600×900 and inspect the resized result.

Open the image with the local image viewer and verify:

- `OPEN WEB AGENT` is spelled correctly.
- The tagline is readable and exact.
- `AGENT`, `MODEL`, and `BROWSER` are distinct and correctly spelled.
- No text is clipped.
- No vendor logos, watermark, robot, or unrelated objects appear.
- The runtime core is visually primary.

- [ ] **Step 4: Commit the banner**

```bash
git add docs/assets/open-web-agent-runtime-banner.png
git commit -m "[docs] add composable runtime banner"
```

### Task 2: Rewrite the public README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the README with the approved structure**

Use this content:

````markdown
# Open Web Agent

![Open Web Agent — bring your own agent, model, and browser](docs/assets/open-web-agent-runtime-banner.png)

**Open Web Agent is not another browser agent. It is a composable runtime for building, running, and inspecting them.**

Bring your own agent, model provider, and browser environment while keeping one execution loop, one event model, and replayable traces.

## Compose Your Runtime

Open Web Agent separates a web agent into interchangeable runtime boundaries:

| Boundary | What you can plug in | Included today |
|---|---|---|
| **Agent** | Reasoning loops and decision policies | ReAct, SeeAct, and project-local Python agents |
| **Model** | Hosted or custom model providers | OpenAI, OpenRouter, Gemini, Claude, and Codex OAuth |
| **Browser** | Browser environments and typed tool adapters | Playwright |

Swap one boundary without rewriting the rest of the runtime. Open Web Agent keeps orchestration, typed browser actions, cancellation, live events, session persistence, JSONL traces, and replay infrastructure consistent across runs.

The plugin contracts are defined in TypeScript. Project-local Python agents can also call the runtime-selected model, so model selection, lifecycle events, and traces remain centralized.

## Product Preview

The CLI starts a loopback-only Hono server, runs real browser automation, streams every run event over SSE to an OpenTUI client, and persists traces for debugging and replay.

![Open Web Agent TUI and Playwright browser](docs/assets/open-web-agent-tui-browser.png)

## Quick Start

Install dependencies with Bun:

```bash
bun install
```

Start the TUI from the current project directory:

```bash
bun run packages/cli/src/index.ts
```

Run a headless one-shot task:

```bash
OPENAI_API_KEY=sk-... \
  bun run packages/cli/src/index.ts run "Open example.com and summarize the page"
```

Development aliases point at the same TUI entry:

```bash
bun run dev
bun run owa
```

Without provider credentials, model-backed runs report that no model is configured.

## Documentation

- [How it works](docs/how-it-works.md) — runtime flow, plugin boundaries, local server, and API routes.
- [CLI and TUI](docs/cli.md) — source commands, slash commands, agents, models, and browsers.
- [Configuration](docs/configuration.md) — YAML, environment variables, credentials, and local data paths.
- [Python agents](docs/python-agents.md) — project-local agent manifests and runtime protocols.
- [Evaluation](docs/evaluation.md) — replay fixture comparisons.
- [Development](docs/development.md) — typecheck and test commands for contributors.

The phased build plan remains in [docs/plan/](docs/plan/).
````

- [ ] **Step 2: Verify image and documentation links**

Run:

```bash
test -f docs/assets/open-web-agent-runtime-banner.png
test -f docs/assets/open-web-agent-tui-browser.png
rg -o '\]\([^)]+' README.md
```

Expected: both image checks exit successfully and every relative README target corresponds to an existing repository path.

- [ ] **Step 3: Check Markdown whitespace**

Run:

```bash
git diff --check -- README.md docs/assets/open-web-agent-runtime-banner.png
```

Expected: no output and exit code 0.

- [ ] **Step 4: Run the required repository typecheck**

Run:

```bash
bun run typecheck
```

Expected: `tsc -b` exits with code 0.

- [ ] **Step 5: Review the final README diff**

Run:

```bash
git diff -- README.md
git status --short
```

Expected:

- README describes Open Web Agent as a composable runtime.
- Current Playwright-only browser support is not overstated.
- Both the new banner and existing product screenshot are referenced.
- `docs/code-review-2026-06-23.md` remains untouched and untracked.

- [ ] **Step 6: Commit the README**

```bash
git add README.md
git commit -m "[docs] position open web agent as a composable runtime"
```

### Task 3: Final verification

**Files:**
- Verify: `README.md`
- Verify: `docs/assets/open-web-agent-runtime-banner.png`
- Verify: `docs/assets/open-web-agent-tui-browser.png`

- [ ] **Step 1: Verify the committed files**

Run:

```bash
git show --stat --oneline HEAD~1..HEAD
git status --short
```

Expected: the banner and README commits are present; only the pre-existing `docs/code-review-2026-06-23.md` remains untracked.

- [ ] **Step 2: Render-check the README assets**

Open both referenced images and inspect the README Markdown source one final time. Confirm that the banner leads the page and the TUI screenshot appears under `Product Preview`.
