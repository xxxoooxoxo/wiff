# wiff

Deterministic, resumable multi-agent workflows for [Codex](https://github.com/openai/codex)
and Claude Code, exposed as a harness-agnostic MCP server. Write plain JavaScript with
`agent()`, `parallel()`, and `pipeline()`; wiff runs the children on a pluggable backend
(Codex app-server threads or headless `claude`, chosen per agent from the model name),
journals every step, and resumes interrupted runs without re-paying for completed work.

Run the server (any MCP client):

```sh
npx @xxxoooxoxo/wiff                      # stdio MCP server: workflow_start / status / wait / cancel
npx -p @xxxoooxoxo/wiff wiff-viewer       # live web viewer on http://127.0.0.1:4979
```

Requires Node >= 22, git for `isolation: "worktree"`, and the CLI of whichever backend your
agents use: `codex` for `gpt-*`/`o*` models (the default), `claude` for `claude-*`/`opus`/
`sonnet`/`haiku`/`fable` models. Set `WIFF_BACKEND=claude` to route unrecognized models to
Claude, and `WIFF_DEFAULT_MODEL` to change the default model.

Full documentation, the workflow script contract, and Codex/Claude Code plugin installs:
**https://github.com/xxxoooxoxo/wiff**
