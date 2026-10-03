#!/bin/bash
# Installs dependencies and Chromium in Claude Code cloud sessions.
# Runs from the SessionStart hook in .claude/settings.json; a no-op locally.

if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}" || exit 0

# Bun's package fetching is known to break behind the cloud security proxy,
# so fall back to npm. Every version in package.json is pinned exactly.
if [ ! -d node_modules/playwright ]; then
  bun install --frozen-lockfile || npm install --no-package-lock --no-audit --no-fund
fi

# Use the project's own Playwright so the browser revision matches.
# Needs cdn.playwright.dev and playwright.download.prss.microsoft.com allowed
# in the cloud environment's network access.
./node_modules/.bin/playwright install --with-deps chromium \
  || ./node_modules/.bin/playwright install chromium \
  || echo "cloud-setup: Chromium install failed; browser tests will not run" >&2

exit 0
