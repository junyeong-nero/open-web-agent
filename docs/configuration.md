# Configuration

Open Web Agent reads user-level runtime settings from `OWA_HOME` when set, otherwise from:

```text
~/.open-web-agent/config.yaml
```

For compatibility, a legacy config at `~/.openwebagents/config.yaml` is read when the unified config file does not exist. New writes go to `~/.open-web-agent/config.yaml`.

## Example Config

```yaml
model: "nvidia/nemotron-3-super-120b-a12b:free"
model_provider: "openrouter"
agent: "see-act"
browser: "playwright-browser"
browser_headless: false
browser_prevent_focus: true
reasoning_effort: "medium"
context_window_tokens: 128000
max_retry: 2
codex_auth_path: "~/.codex/auth.json"

openai_api_key: "sk-..."
openrouter_api_key: "sk-or-..."
gemini_api_key: "..."
anthropic_api_key: "sk-ant-..."

parameters:
  # Leave temperature unset unless the selected model supports custom values.
  # temperature: 1
  # top_p: 1
  # max_tokens: 2048
  # presence_penalty: 0
  # frequency_penalty: 0
  # seed: 42
  # stop:
  #   - "<END>"
  # extra_body:
  #   reasoning_effort: "low"
```

`browser_headless` controls whether the local Playwright browser launches headlessly. The shorter `headless` key is accepted as an alias. In the TUI, use `/headless on` or `/headless off` to persist and apply this setting.

## Environment Variables

Environment variables take precedence over YAML:

```text
OPEN_WEB_AGENT_MODEL
OPEN_WEB_AGENT_MODEL_PROVIDER
OPEN_WEB_AGENT_AGENT
OPEN_WEB_AGENT_BROWSER
OPEN_WEB_AGENT_BROWSER_HEADLESS
OPEN_WEB_AGENT_BROWSER_PREVENT_FOCUS
OPEN_WEB_AGENT_REASONING_EFFORT
OPEN_WEB_AGENT_CONTEXT_WINDOW_TOKENS
OPEN_WEB_AGENT_MAX_RETRY
OPEN_WEB_AGENT_MODEL_TIMEOUT_MS
OPEN_WEB_AGENT_ALLOW_PRIVATE_NETWORK_NAVIGATION
OPEN_WEB_AGENT_CODEX_AUTH_PATH
OPENAI_API_KEY
OPENROUTER_API_KEY
GEMINI_API_KEY
ANTHROPIC_API_KEY
CODEX_ACCESS_TOKEN
```

`OPEN_WEB_AGENT_ALLOW_PRIVATE_NETWORK_NAVIGATION` defaults to false. Set it only for trusted local development or tests that intentionally navigate to loopback or private-network fixtures.

If Codex file-backed ChatGPT auth is available at `codex_auth_path`, or if `CODEX_ACCESS_TOKEN` is set, the runtime registers the `codex-oauth` model provider.

## Local Data

Runtime data and user-level config are stored under `OWA_HOME` when set, otherwise:

```text
~/.open-web-agent
```

Session metadata is stored in SQLite at:

```text
$OWA_HOME/metadata.sqlite
```

Run traces are stored as JSONL under a project-hash directory:

```text
$OWA_HOME/projects/<sha256(project-path)>/sessions/<session-id>/runs/<run-id>/events.jsonl
```
