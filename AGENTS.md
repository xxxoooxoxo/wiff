# AGENTS.md

Instructions for coding agents. Two audiences: agents **orchestrating with wiff** from a harness, and agents **working on this codebase**.

## Orchestrating with wiff (driving it from a harness)

wiff is an MCP server exposing five tools: `workflow_start`, `workflow_status`, `workflow_wait`, `workflow_cancel`, and `workflow_models`. You author a workflow as a plain JavaScript script and pass it to `workflow_start` with an absolute `cwd`; the run executes in the background and everything persists under `~/.wiff/runs/<runId>/`.

**Before authoring a script, read [`plugins/wiff/skills/workflow/references/api.md`](plugins/wiff/skills/workflow/references/api.md) — it is the full script contract.** Inside Codex the bundled `$workflow` skill loads it for you; from any other harness, read it (or copy the skill into your harness's skills directory).

Rules that catch agents out:

- **Workflow code is sandboxed.** No imports, filesystem, shell, network, time, or randomness inside the script — those all throw. Agents do the external work; the script only orchestrates.
- **Give every `agent()` call a stable `key`.** Keys are the resume/cache identity. A run resumed after a crash or script edit replays completed agents with unchanged `(key, input)` for free; without keys you re-pay for everything.
- **`parallel()` takes thunks** (`() => agent(...)`), not started promises, and preserves result order. Any rejection fails the workflow with `AggregateError` — that is deliberate (fail-hard). Use `parallelSettled()` only when the script explicitly handles per-item failure.
- **Defaults:** model `gpt-5.6-sol`, effort `high`, sandbox `read-only`, 30-minute turn timeout. Set `effort: "low"` for mechanical work; raise the sandbox to `workspace-write` only for agents that must edit files.
- **Concurrent writers need `isolation: "worktree"`.** Each writing agent gets a fresh detached git worktree; clean ones vanish, dirty ones are kept and listed on the run for you to inspect or merge. Requires `cwd` to be inside a git repository.
- **Deterministic scripts resume.** To pick up a dead or cancelled run: `workflow_start` with `{ resumeFromRunId }`. Completed agents replay from the journal; agents interrupted mid-turn re-run with a digest of their previous transcript injected.
- **Concurrency is capped** at `min(16, max(2, cores − 2))` running children (excess queue), and a run may request at most 1000 agents.
- **Personas** (`agentType: "name"`) resolve from `<cwd>/.codex/agents/<name>.md`, then `~/.codex/agents/<name>.md` (`CODEX_WORKFLOW_AGENTS_DIR` overrides). Editing a persona invalidates the cache of agents that use it.
- **Don't poll blindly.** `workflow_wait` blocks up to 55 s for a state change; loop on it rather than hammering `workflow_status`.
- **Inspect failures from disk.** `~/.wiff/runs/<runId>/journal.jsonl` records every phase/agent event with input hashes and token usage; `agents/*.jsonl` hold full per-child transcripts. Read those before re-running anything.

## Working on this codebase

- Layout: the whole runtime lives in [`plugins/wiff/`](plugins/wiff/) — `src/server.mjs` (MCP surface), `src/runtime.mjs` (script VM, agent dispatch, journal/resume), `src/workflow-worker.mjs` (run loop), `src/app-server-client.mjs` (Codex app-server transport), `scripts/viewer.mjs` + `scripts/viewer.html` (live viewer), `skills/workflow/` (the bundled skill and API reference).
- **Zero runtime dependencies** — keep it that way. Node >= 22, plain ESM, no build step, no TypeScript.
- Verify changes from `plugins/wiff/`:
  - `npm test` — unit tests against a fake backend; spends no tokens.
  - `npm run check` — syntax-checks every source file.
  - `npm run smoke` — one real Codex child end to end (requires an authenticated `codex` CLI; spends tokens). `npm run smoke -- wf_<run-id>` re-verifies cross-process resume against a completed smoke run without a new model call.
- If you change the script contract or agent options, update [`plugins/wiff/skills/workflow/references/api.md`](plugins/wiff/skills/workflow/references/api.md) and the README example in the same change.
- Codex runs installed plugins from a versioned cache: after editing source, bump the version in `plugins/wiff/.codex-plugin/plugin.json` (and the README badge) so `codex plugin add wiff@wiff` picks up the change.
- The viewer is read-only over the run files and must stay dependency-free; test it against a populated state root with `npm run viewer -- --root <dir>`.
