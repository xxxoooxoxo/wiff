# wiff

Deterministic, resumable multi-agent workflows for [Codex](https://github.com/openai/codex),
Claude Code, Cursor, and Kimi, exposed as a harness-agnostic MCP server. Write plain JavaScript with
`agent()`, `parallel()`, and `pipeline()`; wiff runs the children on a pluggable backend
(Codex app-server threads, headless `claude` or `kimi`, or the Cursor SDK — chosen per agent
from the model name), journals every step, and resumes interrupted runs without re-paying for
completed work.

Run the server (any MCP client):

```sh
npx @xxxoooxoxo/wiff                      # stdio MCP server: start / status / wait / cancel / models
npx -p @xxxoooxoxo/wiff wiff-viewer       # live web viewer on http://127.0.0.1:4979
```

Requires Node >= 22, git for `isolation: "worktree"`, and the runtime of whichever backend
your agents use: Codex CLI >= 0.144.6 for `gpt-*`/`o*` models (the default), the `claude` CLI for
`claude-*`/`opus`/`sonnet`/`haiku`/`fable` models, or `CURSOR_API_KEY` plus the bundled
`@cursor/sdk` for `composer-*` models, or the `kimi` CLI for `kimi-code/*` models. Set
`WIFF_BACKEND` to route unrecognized models to a specific backend, and `WIFF_DEFAULT_MODEL`
to change the default model. Agent calls default to medium reasoning effort and a 10-minute
execution timeout; time waiting for a concurrency slot is tracked separately. Wiff-launched
Codex children disable plugins, apps, and configured MCP servers only inside their app-server
process so normal interactive Codex configuration is unchanged.

Full documentation, the workflow script contract, and Codex/Claude Code plugin installs:
**https://github.com/xxxoooxoxo/wiff**
