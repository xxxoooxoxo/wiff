# Workflow API

## Script contract

Scripts use top-level `await` and `return`:

```js
export const meta = {
  name: "audit-routes",
  description: "Audit route authorization",
  phases: [{ title: "Audit", detail: "Inspect every route" }],
};

phase("Audit");
const results = await parallel(
  args.files.map((file) => () =>
    agent(`Audit ${file}`, {
      key: `audit:${file}`,
      sandbox: "read-only",
      schema: resultSchema,
    }),
  ),
);
return results;
```

Workflow JavaScript cannot import modules or directly use the filesystem, shell, network, current time, or randomness. Ask an agent to perform external work.

## Globals

### `args`

The JSON value supplied to `workflow_start`.

### `agent(prompt, options)`

Start one Codex thread and return its final response. With `schema`, return parsed JSON; otherwise return text.

Options:

- `key`: stable resume/cache key. Strongly recommended.
- `label`: human-readable activity label.
- `model`: Codex model id. Defaults to `gpt-5.6-sol`.
- `effort`: reasoning effort. Defaults to `high`.
- `sandbox`: `read-only`, `workspace-write`, or `danger-full-access`. Defaults to `read-only`.
- `schema`: JSON Schema for the final response.
- `cwd`: absolute child working directory. Defaults to the run directory.
- `timeoutMs`: child turn timeout. Defaults to 30 minutes.
- `isolation`: `"worktree"` runs the agent in a fresh detached git worktree of the run cwd's
  repository (created under the run directory). Clean worktrees are removed when the agent
  finishes; worktrees with uncommitted changes are kept and listed in the run's `worktrees`
  array so the orchestrator can inspect or merge them. Requires the cwd to be inside a git
  repository. Use this whenever multiple `workspace-write` agents run concurrently.
- `agentType`: name of a persona applied as the child's developer instructions. Resolved from
  `<cwd>/.codex/agents/<name>.md`, then `~/.codex/agents/<name>.md` (override the latter with
  `CODEX_WORKFLOW_AGENTS_DIR`). Optional `---` frontmatter keys `model`, `effort`, and
  `sandbox` become defaults for the agent; explicit options win. Editing a persona invalidates
  cached results for agents that use it.

### `parallel(thunks, options?)`

Run zero-argument functions concurrently while preserving result order. The default concurrency is the runtime limit. Any rejection fails with `AggregateError`.

### `parallelSettled(thunks, options?)`

Run concurrently and return `{ status, value }` or `{ status, reason }` for each item. Use only when the workflow explicitly handles failures.

### `pipeline(items, ...stages, options?)`

Run items concurrently and stages sequentially per item. The first stage receives `(item, item, index)`; later stages receive `(previousResult, originalItem, index)`. A final plain object configures `concurrency`.

### `phase(name)` and `log(value)`

Record phase and diagnostic events in the run journal.

## Mid-turn resume

Resuming a run replays completed agents from cache; agents whose previous attempt
started but never completed re-run with recovery context injected automatically:

- The prompt is prefixed with a `[resume]` digest of the interrupted attempt's
  transcript tail (commands run, files edited, findings), instructing the agent to
  continue rather than start over.
- With `isolation: "worktree"`, the interrupted attempt's partial checkout is handed
  to the new attempt instead of being recreated, so file work already done survives.
- Cache keys are unaffected: the digest is injected after hashing, so a later resume
  still replays the completed result.

## MCP tools

- `workflow_start`: launch new work or resume an existing run.
- `workflow_status`: read current run state.
- `workflow_wait`: wait up to 55 seconds for state to change or finish.
- `workflow_cancel`: interrupt a live run.

Run artifacts are stored under `~/.wiff/runs/<runId>/` unless `WIFF_HOME` (or legacy `CODEX_WORKFLOW_HOME`) overrides the root.
