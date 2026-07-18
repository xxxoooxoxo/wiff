# wiff

Deterministic, resumable multi-agent workflows for [Codex](https://github.com/openai/codex),
Claude Code, and Cursor, exposed as a harness-agnostic MCP server. Write plain JavaScript with
`agent()`, `parallel()`, and `pipeline()`; wiff runs the children on a pluggable backend
(Codex app-server threads, headless `claude`, or the Cursor SDK — chosen per agent from the
model name), journals every step, and resumes interrupted runs without re-paying for
completed work.

Run the server (any MCP client):

```sh
npx @xxxoooxoxo/wiff                      # stdio MCP server: start / status / wait / cancel / models
npx -p @xxxoooxoxo/wiff wiff-viewer       # live web viewer on http://127.0.0.1:4979
```

Requires Node >= 22, git for `isolation: "worktree"`, and the runtime of whichever backend
your agents use: the `codex` CLI for `gpt-*`/`o*` models (the default), the `claude` CLI for
`claude-*`/`opus`/`sonnet`/`haiku`/`fable` models, or `CURSOR_API_KEY` plus the bundled
`@cursor/sdk` for `composer-*` models. Set `WIFF_BACKEND` to route unrecognized models to a
specific backend, and `WIFF_DEFAULT_MODEL` to change the default model.

Full documentation, the workflow script contract, and Codex/Claude Code plugin installs:
**https://github.com/xxxoooxoxo/wiff**
