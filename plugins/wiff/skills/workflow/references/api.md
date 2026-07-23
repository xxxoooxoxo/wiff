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

Start one child agent and return its final response. With `schema`, return parsed JSON; otherwise return text. The backend is chosen per agent from the model name (see Backends below).

Options:

- `key`: stable resume/cache key. Strongly recommended. Execution-only controls such as
  `timeoutMs` do not invalidate a completed result.
- `label`: human-readable activity label.
- `model`: model id. Defaults to `gpt-5.6-sol` (override with `WIFF_DEFAULT_MODEL`). The model prefix picks the backend: `gpt-*`/`o*`/`codex*` run on Codex, `claude-*`/`opus`/`sonnet`/`haiku`/`fable` run on Claude Code, `composer-*` runs on Cursor, and `kimi-code/*` runs on Kimi.
- `provider`: explicit backend (`codex`, `claude`, `cursor`, or `kimi`), overriding model-prefix inference.
- `effort`: reasoning effort. Defaults to `medium`. Prefer `low` for mechanical inventory,
  `medium` for ordinary implementation, and reserve `high`/`xhigh` for the few review or
  synthesis turns that need it.
- `sandbox`: `read-only`, `workspace-write`, or `danger-full-access`. Defaults to `read-only`.
- `schema`: JSON Schema for the final response.
- `cwd`: absolute child working directory. Defaults to the run directory.
- `timeoutMs`: child execution timeout. Defaults to 10 minutes and starts only after the agent
  acquires a runtime concurrency slot; queue time is recorded separately.
- `isolation`: `"worktree"` runs the agent in a fresh detached git worktree of the run cwd's
  repository (created under the run directory). Clean worktrees are removed when the agent
  finishes; worktrees with uncommitted changes are kept and listed in the run's `worktrees`
  array so the orchestrator can inspect or merge them. Requires the cwd to be inside a git
  repository. Use this whenever multiple `workspace-write` agents run concurrently.
- `agentType`: name of a persona applied as the child's developer instructions. Resolved from
  `<cwd>/.codex/agents/<name>.md`, then `~/.codex/agents/<name>.md` (override the latter with
  `CODEX_WORKFLOW_AGENTS_DIR`). Optional `---` frontmatter keys `model`, `effort`, `sandbox`,
  and `provider` become defaults for the agent; explicit options win. Editing a persona
  invalidates cached results for agents that use it.

## Backends

Agents run on a pluggable backend selected per call: explicit `provider` option, else the
`model` prefix, else `WIFF_BACKEND` (defaults to `codex`). Mixed-backend workflows just work —
`model` is part of the cache key, so resume semantics are identical across backends.

- **codex** — native Codex threads over one long-lived `codex app-server` process. Before launch,
  Wiff disables Codex plugins/apps, enumerates the remaining configured MCP servers, and disables
  each one for the child app-server only. This avoids recursive/duplicated MCP process trees
  without changing interactive Codex configuration. `sandbox` is OS-enforced; `schema` uses
  native structured output. Requires Codex CLI >= 0.144.6.
- **claude** — one headless `claude -p` process per agent (`--no-session-persistence`, user
  settings/hooks/MCP servers disabled). `schema` maps to native `--json-schema`; personas map
  to `--append-system-prompt`; `effort` maps directly (Claude additionally accepts `max`).
  There is no OS sandbox, so sandbox levels map to permission policy: `read-only` exposes only
  the Read/Glob/Grep tools; `workspace-write` **requires `isolation: "worktree"`** (the
  worktree is the write-isolation mechanism) and enables auto-accepted edits plus Bash;
  `danger-full-access` bypasses permissions entirely.
- **cursor** — runs agents through the official Cursor SDK (`@cursor/sdk`, an optional
  dependency) in local mode, authenticated via `CURSOR_API_KEY`. The SDK has no system-prompt
  channel or native structured output, so personas are prepended to the prompt and `schema`
  is exposed as an in-process `structured_output` custom tool the agent must call. Cursor's
  sandbox only gates command execution: `read-only` is advisory (sandbox on plus a do-not-write
  instruction), `workspace-write` requires `isolation: "worktree"` like the claude backend,
  and `danger-full-access` disables the sandbox. `effort` is ignored.
- **kimi** — one headless `kimi -p` process per agent, using full configured model aliases such
  as `kimi-code/k3`. The CLI has no system-prompt channel or native structured output, so personas
  are prepended to the prompt, the schema-only directive is appended after the task, and schema
  results are parsed from the final message. Print mode auto-approves every tool and has no OS
  sandbox: `read-only` is advisory only,
  `workspace-write` **requires `isolation: "worktree"`**, and `danger-full-access` runs as-is.
  `effort` is accepted but ignored because thinking effort comes from the CLI's `config.toml`.

### `parallel(thunks, options?)`

Run zero-argument functions concurrently while preserving result order. The default concurrency is the runtime limit. Any rejection fails with `AggregateError`.
Agents waiting for that limit emit `agent.queued`; `agent.started` means the backend turn is
actually executing. Completion/failure events include `queueMs` and `executionMs`.
Queue waits do not have an implicit deadline; cancel the workflow to release queued agents if
executing backends stop making progress.

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
- Journals created before 0.6.1 retain their legacy default-option hashes. Wiff accepts those
  hashes during resume so upgrading does not replay completed agents or discard interrupted
  transcripts/worktrees; newly executed turns use the current defaults.

## MCP tools

- `workflow_start`: launch new work or resume an existing run.
- `workflow_status`: read current run state, including `ownerResponsive` and `heartbeatAgeMs`
  while a run is live. An unresponsive owner is reported without making the run terminal.
- `workflow_wait`: wait up to 55 seconds for state to change or finish.
- `workflow_cancel`: interrupt a live run.
- `workflow_models`: list the models each backend can run (with supported reasoning efforts
  where the backend reports them). Backends that are unavailable on the machine report an
  error entry instead of failing the listing — useful before writing a mixed-backend script.

Run artifacts are stored under `~/.wiff/runs/<runId>/` unless `WIFF_HOME` (or legacy `CODEX_WORKFLOW_HOME`) overrides the root.
