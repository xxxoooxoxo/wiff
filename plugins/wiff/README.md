# wiff

Deterministic, resumable multi-agent workflows for [Codex](https://github.com/openai/codex),
Claude Code, Cursor, and Kimi, exposed as a harness-agnostic MCP server. Write plain JavaScript with
`agent()`, `/goal` stages, `parallel()`, and `pipeline()`; wiff runs the children on a pluggable backend
(Codex app-server threads, headless `claude` or `kimi`, or the Cursor SDK — chosen per agent
from the model name), journals every step, and resumes interrupted runs without re-paying for
completed work.

At a Codex stage that must keep going until a condition is genuinely met, prefix the agent prompt
with `/goal`:

```js
phase("Verify and repair");
await agent("/goal Make the unit tests pass and verify the final run.", {
  key: "tests-green",
  sandbox: "workspace-write",
  timeoutMs: 30 * 60 * 1_000,
});
```

Wiff keeps that Codex thread at the current workflow stage while its goal is active. The workflow
advances only when the worker marks the goal complete; blocked or limited goals fail explicitly.

Persistent preferences live in `~/.wiff/config.json`, with optional project overrides at
`<cwd>/.wiff/config.json`. They can provide user instructions, default agent options, ordered
cross-backend `fallbackModels`, and matching rules that select models or turn phases into `/goal`
stages. Wiff injects applicable instructions alongside the task and includes the effective
preference decision in the resume-cache identity. See the
[workflow API reference](skills/workflow/references/api.md#user-and-project-preferences) for the
schema and precedence rules.

Run the server (any MCP client):

```sh
npx @xxxoooxoxo/wiff                      # stdio MCP server: start / status / wait / cancel / models
npx -p @xxxoooxoxo/wiff wiff-viewer       # live web viewer on http://127.0.0.1:4979
```

Goal stages are marked directly in the workflow graph as queued, active, met, failed, or replayed.

Requires Node >= 22, git for `isolation: "worktree"`, and the runtime of whichever backend
your agents use: Codex CLI >= 0.144.6 for `gpt-*`/`o*` models (the default), the `claude` CLI for
current `claude-fable-5`/`claude-opus-5`/`claude-sonnet-5`/`claude-haiku-4-5` models and the
moving `fable`/`opus`/`sonnet`/`haiku` aliases, or `CURSOR_API_KEY` plus the bundled
`@cursor/sdk` for `composer-*` models, or the `kimi` CLI for `kimi-code/*` models. Set
`WIFF_BACKEND` to route unrecognized models to a specific backend, and `WIFF_DEFAULT_MODEL`
to change the default model. Agent calls default to medium reasoning effort and a 10-minute
execution timeout; time waiting for a concurrency slot is tracked separately. Wiff-launched
Codex children disable plugins, apps, and configured MCP servers only inside their app-server
process so normal interactive Codex configuration is unchanged.

Full documentation, the workflow script contract, and Codex/Claude Code plugin installs:
**https://github.com/xxxoooxoxo/wiff**
