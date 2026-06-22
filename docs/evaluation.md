# Evaluation

Replay fixture comparisons with:

```bash
bun run packages/cli/src/index.ts eval --task example-domain-title
```

Provide explicit runtime combinations with `agent/model/browser`:

```bash
bun run packages/cli/src/index.ts eval \
  --task example-domain-title \
  --combo simple-react-agent/openrouter/playwright-browser \
  --combo plan-act/openrouter:openai/gpt-5.2-codex/playwright-browser
```

The combo parser splits on the first and last slash, so model IDs may contain slashes.

