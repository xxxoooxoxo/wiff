# wiff

**Deterministic, resumable multi-agent workflows for [Codex](https://github.com/openai/codex) — written as plain JavaScript. Like `wf`, but wiff.**

![MIT License](https://img.shields.io/badge/license-MIT-blue) ![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![Version](https://img.shields.io/badge/version-0.4.0-informational)

Fan a task out to a fleet of Codex agents with a small script instead of a prayer. You write ordinary JavaScript with `agent()`, `parallel()`, and `pipeline()`; the runtime executes it in the background, journals every step, and — when a run dies halfway through — resumes it without re-paying for a single completed agent.

```js
export const meta = {
  name: "audit",
  description: "Audit files in parallel, fix confirmed issues in isolation",
  phases: [{ title: "Audit" }, { title: "Fix" }],
};

phase("Audit");
const findings = await parallel(
  args.files.map((file) => () =>
    agent(`Audit ${file} for auth bugs`, {
      key: `audit:${file}`,          // stable key → free replay on resume
      sandbox: "read-only",
      schema: findingSchema,          // structured JSON output
    }),
  ),
);

phase("Fix");
return await parallel(
  findings.filter((f) => f.real).map((f) => () =>
    agent(`Fix: ${f.summary}`, {
      key: `fix:${f.file}`,
      agentType: "surgeon",           // persona from .codex/agents/surgeon.md
      isolation: "worktree",          // own git worktree — parallel writes can't collide
      sandbox: "workspace-write",
    }),
  ),
);
```

## Why

Ad-hoc multi-agent orchestration ("spawn some subagents for this") is great until the run is 40 agents deep and something dies. Workflows-as-code give you:

- **Determinism** — the orchestration is a script, not vibes. No time, randomness, filesystem, or network inside workflow code; agents do the external work.
- **Resume, not retry** — every agent call is journaled with a stable key and an input hash. Kill the host, edit the script, resume the run: unchanged completed agents replay from cache instantly and for free. Agents that were interrupted **mid-turn** re-run with a digest of their previous attempt's transcript injected ("here's what you already did — continue"), and worktree agents inherit their partial checkout instead of starting over.
- **Fail-hard semantics** — a rejected agent fails the workflow loudly (`parallelSettled()` is the explicit opt-out). No silent `null`s masquerading as success.
- **Isolation where it matters** — `isolation: "worktree"` gives each writing agent a fresh detached git worktree. Clean ones vanish; dirty ones are kept and listed on the run for you to inspect or merge.
- **Personas** — `agentType: "reviewer"` injects a markdown persona as the child's developer instructions, with frontmatter defaults for model/effort/sandbox.

## Install

```sh
codex plugin marketplace add https://github.com/xxxoooxoxo/wiff.git
codex plugin add wiff@wiff
```

Or from a local checkout:

```sh
git clone https://github.com/xxxoooxoxo/wiff.git
codex plugin marketplace add ./wiff
codex plugin add wiff@wiff
```

Then start a new Codex session and either invoke the bundled skill with `$workflow` or just ask: *"run this as a resumable workflow."*

Installing the plugin auto-approves its four workflow-controller tools so headless and desktop runs don't stop at an MCP approval prompt. Agent filesystem access is still governed per-call by `sandbox`.

## Using from other harnesses (Claude Code, Cursor, any MCP client)

The Codex *plugin* is just packaging. The engine underneath is a plain stdio MCP server, so any
MCP-speaking harness can orchestrate wiff workflows. The mental model: **the orchestrator is
pluggable, the workers are not** — whoever drives, `agent()` children always run on Codex via a
local `codex app-server`.

Requirements on the machine, regardless of harness: the `codex` CLI installed and authenticated,
Node >= 22, and git if you use `isolation: "worktree"`.

**Claude Code**

```sh
claude mcp add wiff -- node /path/to/wiff/plugins/wiff/src/server.mjs
```

Tool calls go through Claude Code's own permission system; to skip per-call prompts, allow the
four tools in `.claude/settings.json`:

```json
{ "permissions": { "allow": [
  "mcp__wiff__workflow_start", "mcp__wiff__workflow_status",
  "mcp__wiff__workflow_wait", "mcp__wiff__workflow_cancel"
] } }
```

**Cursor / Windsurf / Claude Desktop** — add the server to the client's `mcp.json`:

```json
{
  "mcpServers": {
    "wiff": { "command": "node", "args": ["/path/to/wiff/plugins/wiff/src/server.mjs"] }
  }
}
```

Notes for non-Codex hosts:

- **State is shared.** Every harness reads and writes the same `~/.wiff/runs/`, so a run started
  from Codex can be watched, cancelled, or resumed from Claude Code (and vice versa), and the
  live viewer sees everything.
- **Bring the script contract into context.** The `$workflow` skill only auto-loads inside Codex.
  From other harnesses, point the model at
  [`plugins/wiff/skills/workflow/references/api.md`](plugins/wiff/skills/workflow/references/api.md)
  (or copy the skill into your harness's skill/rules directory, e.g. `.claude/skills/` or Cursor
  rules) so it authors valid scripts.
- **Personas** resolve from `<cwd>/.codex/agents/` then `~/.codex/agents/` on every harness; set
  `CODEX_WORKFLOW_AGENTS_DIR` in the server's env to point somewhere else (e.g. a shared
  `~/.claude/agents`).
- `workflow_start` requires an explicit absolute `cwd`, so the server's own working directory
  doesn't matter to results.

## How it works

The plugin is an MCP server exposing four tools: `workflow_start`, `workflow_status`, `workflow_wait`, `workflow_cancel`. A started workflow runs its script inside a locked-down Node `vm` (no imports, filesystem, shell, network, time, or randomness — those all throw). Each `agent()` call is dispatched to a shared local `codex app-server`, which runs the child thread with your model/effort/sandbox settings; recursive orchestration is disabled inside children.

Everything about a run persists under `~/.wiff/runs/<runId>/`:

```
run.json         status, phase, counters, failures, kept worktrees
script.js        the exact source (reread on resume)
journal.jsonl    every phase/log/agent event, with input hashes and token usage
agents/*.jsonl   full per-child transcripts
worktrees/       isolated checkouts for agents that asked for them
```

Status, waits, cancellation, and resume all work across host restarts — a second Codex session can observe, cancel, or resume a run it didn't start.

See [the API reference](plugins/wiff/skills/workflow/references/api.md) for the full script contract and [`examples/verify-and-fix.js`](plugins/wiff/examples/verify-and-fix.js) for a staged example.

## Live viewer

Watch every run — and every agent inside it — in a local web UI:

```sh
cd plugins/wiff
npm run viewer     # http://127.0.0.1:4979  (--port / --root to override)
```

Zero dependencies, read-only over the run files, so it can watch runs owned by any process. A live strip across the top shows **every running agent in every run** with what it's doing right now (its latest command, file edit, or thought, tailed from the transcript). Below that: per-phase agent cards with live status lines, a gantt timeline, token counts, kept worktrees, and a click-through live-tailing transcript drawer. Light and dark themes.

## Roadmap

- [Model-agnostic backends](https://github.com/xxxoooxoxo/wiff/issues/1) — run individual agents on Claude or Gemini alongside Codex, routed by model name.

## Related projects

- [robzilla1738/Codex-Workflows](https://github.com/robzilla1738/Codex-Workflows) — workflow-as-code runtime for Codex focused on review fan-out. Convergent design, independent implementation.
- [scasella/claude-dynamic-workflows-codex](https://github.com/scasella/claude-dynamic-workflows-codex) — Claude Code's dynamic-workflows DSL re-hosted on GPT agents, with sessionful workers and a browser run viewer.
- Codex's native subagents — great for interactive, human-supervised fan-out; this plugin is for the automated, resumable, journaled kind.

## Development

```sh
cd plugins/wiff
npm test        # unit tests (fake backend, no tokens spent)
npm run check   # syntax check
npm run smoke   # one real Codex child, end to end
```

Pass a completed smoke run id to verify cross-process resume without another model call:

```sh
npm run smoke -- wf_<run-id>
```

Codex runs installed plugins from a versioned cache — after editing source, bump the version in `.codex-plugin/plugin.json` and re-run `codex plugin add wiff@wiff` to pick up changes.

## License

[MIT](LICENSE)
