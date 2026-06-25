# Public README and Banner Design

## Goal

Position Open Web Agent as a composable runtime for web agents rather than another prebuilt browser agent.

The public message is:

> Bring your own agent, model, and browser.

Open Web Agent supplies the shared execution loop, typed runtime boundaries, event stream, persistence, terminal interface, and replayable traces.

## README Structure

The README introduction will:

1. Lead with the distinction: Open Web Agent is a runtime for building and running web agents.
2. Explain the three interchangeable extension axes:
   - Agent implementations
   - Model providers
   - Browser environments and their tool adapters
3. Describe the stable runtime services retained when a component changes:
   - Orchestration
   - Typed actions and observations
   - Live events
   - Session persistence
   - JSONL traces and replay
4. Clearly separate current support from architectural extensibility:
   - Current agents include TypeScript agents and project-local Python agents.
   - Current model providers include OpenAI, OpenRouter, Gemini, Claude, and Codex OAuth.
   - The built-in browser environment is Playwright.
   - Additional browser environments require implementing the existing plugin contracts.
5. Keep the existing quick-start and documentation links concise.

## Banner

Create a 1600×900 dark technical illustration suitable for the top of the GitHub README.

Visual direction:

- Near-black background with subtle depth and restrained cyan/violet lighting.
- A luminous runtime core as the central anchor.
- Three surrounding modules labeled `AGENT`, `MODEL`, and `BROWSER`.
- Thin orbital or connector lines showing that each module plugs into the same runtime.
- Strong title: `OPEN WEB AGENT`.
- Supporting line: `BRING YOUR OWN AGENT, MODEL, AND BROWSER.`
- Minimal composition with ample negative space and no vendor logos.
- Crisp technical/editorial style rather than a literal robot, browser screenshot, or generic AI artwork.

The image must remain readable when GitHub scales it down and should work against both light and dark GitHub themes.

## Asset and Integration

- Save the generated bitmap under `docs/assets/`.
- Use a stable descriptive filename.
- Replace the current screenshot at the top of the README with the new banner.
- Retain the existing TUI/browser screenshot later in the README as a product preview.

## Verification

- Confirm the generated asset is exactly 1600×900 or another 16:9 resolution suitable for GitHub.
- Visually inspect the final image for text legibility, clipping, artifacts, and hierarchy.
- Verify every README image path resolves.
- Run Markdown-oriented repository checks if present, then run `bun run typecheck` because project guidance requires it after changes.
