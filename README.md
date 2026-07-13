# Codex Workflows

**Deterministic, resumable multi-agent workflows for [Codex](https://github.com/openai/codex) — written as plain JavaScript.**

![MIT License](https://img.shields.io/badge/license-MIT-blue) ![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![Version](https://img.shields.io/badge/version-0.2.0-informational)

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
- **Resume, not retry** — every agent call is journaled with a stable key and an input hash. Kill the host, edit the script, resume the run: unchanged completed agents replay from cache instantly and for free.
- **Fail-hard semantics** — a rejected agent fails the workflow loudly (`parallelSettled()` is the explicit opt-out). No silent `null`s masquerading as success.
- **Isolation where it matters** — `isolation: "worktree"` gives each writing agent a fresh detached git worktree. Clean ones vanish; dirty ones are kept and listed on the run for you to inspect or merge.
- **Personas** — `agentType: "reviewer"` injects a markdown persona as the child's developer instructions, with frontmatter defaults for model/effort/sandbox.

## Install

```sh
codex plugin marketplace add https://github.com/xxxoooxoxo/codex-workflows.git
codex plugin add codex-workflows@codex-workflows-local
```

Or from a local checkout:

```sh
git clone https://github.com/xxxoooxoxo/codex-workflows.git
codex plugin marketplace add ./codex-workflows
codex plugin add codex-workflows@codex-workflows-local
```

Then start a new Codex session and either invoke the bundled skill with `$workflow` or just ask: *"run this as a resumable workflow."*

Installing the plugin auto-approves its four workflow-controller tools so headless and desktop runs don't stop at an MCP approval prompt. Agent filesystem access is still governed per-call by `sandbox`.

## How it works

The plugin is an MCP server exposing four tools: `workflow_start`, `workflow_status`, `workflow_wait`, `workflow_cancel`. A started workflow runs its script inside a locked-down Node `vm` (no imports, filesystem, shell, network, time, or randomness — those all throw). Each `agent()` call is dispatched to a shared local `codex app-server`, which runs the child thread with your model/effort/sandbox settings; recursive orchestration is disabled inside children.

Everything about a run persists under `~/.codex/workflows/runs/<runId>/`:

```
run.json         status, phase, counters, failures, kept worktrees
script.js        the exact source (reread on resume)
journal.jsonl    every phase/log/agent event, with input hashes and token usage
agents/*.jsonl   full per-child transcripts
worktrees/       isolated checkouts for agents that asked for them
```

Status, waits, cancellation, and resume all work across host restarts — a second Codex session can observe, cancel, or resume a run it didn't start.

See [the API reference](plugins/codex-workflows/skills/workflow/references/api.md) for the full script contract and [`examples/verify-and-fix.js`](plugins/codex-workflows/examples/verify-and-fix.js) for a staged example.

## Roadmap

- [Model-agnostic backends](https://github.com/xxxoooxoxo/codex-workflows/issues/1) — run individual agents on Claude or Gemini alongside Codex, routed by model name.

## Related projects

- [robzilla1738/Codex-Workflows](https://github.com/robzilla1738/Codex-Workflows) — workflow-as-code runtime for Codex focused on review fan-out. Convergent design, independent implementation.
- [scasella/claude-dynamic-workflows-codex](https://github.com/scasella/claude-dynamic-workflows-codex) — Claude Code's dynamic-workflows DSL re-hosted on GPT agents, with sessionful workers and a browser run viewer.
- Codex's native subagents — great for interactive, human-supervised fan-out; this plugin is for the automated, resumable, journaled kind.

## Development

```sh
cd plugins/codex-workflows
npm test        # unit tests (fake backend, no tokens spent)
npm run check   # syntax check
npm run smoke   # one real Codex child, end to end
```

Pass a completed smoke run id to verify cross-process resume without another model call:

```sh
npm run smoke -- wf_<run-id>
```

Codex runs installed plugins from a versioned cache — after editing source, bump the version in `.codex-plugin/plugin.json` and re-run `codex plugin add codex-workflows@codex-workflows-local` to pick up changes.

## License

[MIT](LICENSE)
