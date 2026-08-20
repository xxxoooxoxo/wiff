---
name: workflow
description: Create, run, monitor, cancel, or resume deterministic JavaScript workflows that orchestrate multiple Codex, Claude, Cursor, or Kimi agents. Use for parallel investigation or review, staged agent pipelines, resumable long-running work, or when the user explicitly asks for a workflow, orchestration, fan-out, or several independent agents.
---

# wiff

Use workflow code when the plan itself benefits from deterministic branching, parallelism, or resumability. Keep simple one-agent tasks in the current task.

## Build and launch

1. Write a self-contained JavaScript workflow. Start with literal `export const meta = { name, description, creator, phases }`. Set `creator` to your own model name so the run is attributed to whoever authored it.
2. Put all context each child needs in its prompt. Child agents inherit project instructions, not the parent conversation.
3. Use stable `key` values for every reusable `agent()` call.
4. Wiff automatically applies user preferences from `~/.wiff/config.json` and project preferences
   from `<cwd>/.wiff/config.json`; do not duplicate those instructions in child prompts.
5. Prefix a Codex agent prompt with `/goal` when that stage must continue across turns until its
   objective is complete. Give the whole goal stage an appropriate `timeoutMs`.
6. Launch with `workflow_start`. Always pass the caller's absolute working directory as `cwd`. Record the returned run id; execution is owned by a persistent local daemon and survives this MCP bridge or parent harness exiting.
7. Call `workflow_wait` until the run reaches `completed`, `failed`, or `cancelled` while the parent remains available. If the parent must end, report the run id so another client can reconnect. Inspect `runPath` and `journalPath` when diagnosing failure.
8. Resume failed or interrupted work with `workflow_start({ resumeFromRunId })`. Completed calls with unchanged keys and inputs are replayed from the journal.
9. Use `workflow_models` before choosing a non-default backend or model when availability is uncertain.

Read [references/api.md](references/api.md) before authoring a non-trivial workflow.

## Safety

- Run independent analysis with `sandbox: "read-only"` in parallel.
- Serialize agents writing to one checkout, or give concurrent writers `isolation: "worktree"`.
- Claude, Cursor, and Kimi `workspace-write` agents require `isolation: "worktree"`.
- Do not treat a failed agent as success. `parallel()` and `pipeline()` fail the run unless the script explicitly uses `parallelSettled()` and handles every rejection.
- Prefer `gpt-5.6-sol`. Use low effort for mechanical inventory, medium for ordinary
  implementation, and high or xhigh only for the few review or synthesis turns that need it.
- Set a task-specific `timeoutMs` when 10 minutes is not appropriate. The timeout covers the
  executing backend turn; time waiting for a concurrency slot is measured separately.
- Keep every launched workflow accounted for. Normally wait for a terminal result or cancel it; if the parent must exit, preserve and report the run id for a later watcher.

## Saved workflows

Store project workflows in `.codex/workflows/*.js` and personal workflows in `~/.codex/workflows/*.js`. Prefer project workflows when names collide.
