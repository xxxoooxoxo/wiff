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

### User and project preferences

Wiff loads optional JSON preferences from two locations for every new or resumed run:

1. `<WIFF_HOME>/config.json` (normally `~/.wiff/config.json`) — user-wide preferences.
2. `<workflow cwd>/.wiff/config.json` — project preferences.

Project defaults override user defaults. Explicit `agent()` options override defaults, while
matching rules are applied afterward as user policy and can override generated workflow options.
User and project instructions are combined and delivered to every matching worker as explicit
user preferences in addition to its task.

```json
{
  "version": 1,
  "instructions": "Prefer source-backed conclusions and verify before reporting success.",
  "defaults": {
    "model": "claude-sonnet-5",
    "effort": "medium",
    "fallbackModels": ["gpt-5.6-sol"]
  },
  "rules": [
    {
      "name": "deep-review",
      "when": {
        "phase": ["Review", "Audit"],
        "promptIncludes": ["security", "payment"]
      },
      "instructions": "Review adversarially and report only concrete defects.",
      "options": {
        "model": "claude-opus-5",
        "effort": "high",
        "fallbackModels": ["gpt-5.6-sol", "claude-sonnet-5"]
      }
    },
    {
      "name": "fix-until-green",
      "when": {
        "phase": ["Fix", "Repair"]
      },
      "goal": "Do not finish until the relevant tests pass.",
      "options": {
        "model": "gpt-5.6-sol",
        "fallbackModels": ["gpt-5.6-terra"]
      }
    }
  ]
}
```

`when.phase` and `when.key` accept a string or array and match any listed value.
`when.promptIncludes` performs a case-insensitive any-term match. All supplied `when` fields must
match. Rules run in file order, user rules before project rules; later matching values win while
their `instructions` accumulate.

Preference `defaults` and rule `options` accept `model`, `provider`, `effort`, `sandbox`,
`timeoutMs`, `isolation`, and `fallbackModels`. A rule's `goal` may be `true` (use the agent
request as the objective), `false`, or a completion-condition string appended to the objective.
Native `/goal` execution still requires a Codex model, so a goal rule should select Codex or
provide a Codex fallback.

Unknown keys, invalid values, and malformed JSON fail `workflow_start` instead of being ignored.
Run records contain preference source paths and hashes, not the preference text. The effective
preference decision participates in each agent's cache identity, so editing applicable
instructions, rules, models, or goal conditions causes that agent to run again on resume.

### `agent(prompt, options)`

Start one child agent and return its final response. With `schema`, return parsed JSON; otherwise return text. The backend is chosen per agent from the model name (see Backends below).

Options:

- `key`: stable resume/cache key. Strongly recommended. Execution-only controls such as
  `timeoutMs` do not invalidate a completed result.
- `label`: human-readable activity label.
- `model`: model id. Defaults to `gpt-5.6-sol` (override with `WIFF_DEFAULT_MODEL`). The model prefix picks the backend: `gpt-*`/`o*`/`codex*` run on Codex, `claude-*`/`opus`/`sonnet`/`haiku`/`fable` run on Claude Code, `composer-*`/`cursor-*`/`grok-*` run on Cursor, and `kimi-code/*` runs on Kimi. Cursor Grok ids are `grok-4.6` (and `cursor-grok-4.6` / `cursor-grok-4.6-xhigh-fast` slugs, which Wiff normalizes to the catalog id). Codex Fast mode uses the same suffix: `gpt-5.6-sol-fast` or `gpt-5.6-sol-xhigh-fast`.
  Current explicit Claude ids include `claude-fable-5`, `claude-opus-5`,
  `claude-sonnet-5`, and `claude-haiku-4-5`; the short family names remain moving aliases for
  the latest model available through the installed Claude CLI.
- `fallbackModels`: ordered model ids attempted after the primary model fails. Fallback model
  prefixes select their own backends, so a path may cross providers. Fallback transitions are
  written to the agent transcript. Cancellation never triggers a fallback.
- `provider`: explicit backend (`codex`, `claude`, `cursor`, or `kimi`), overriding model-prefix inference.
- `effort`: reasoning effort. Defaults to `medium`. Prefer `low` for mechanical inventory,
  `medium` for ordinary implementation, and reserve `high`/`xhigh` for the few review or
  synthesis turns that need it.
- `sandbox`: `read-only`, `workspace-write`, or `danger-full-access`. Defaults to `read-only`.
- `schema`: JSON Schema for the final response.
- `cwd`: absolute child working directory. Defaults to the run directory.
- `timeoutMs`: child execution timeout. Defaults to 10 minutes and starts only after the agent
  acquires a runtime concurrency slot; queue time is recorded separately. For a `/goal` stage,
  the timeout covers the complete multi-turn goal rather than resetting for every continuation.
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

### `/goal` agent stages

Prefix a Codex agent prompt with `/goal` when the workflow must remain at that stage until an
objective is actually satisfied:

```js
phase("Repair");
const repair = await agent(
  `/goal Make the unit tests pass. Diagnose failures, implement the fixes, and verify the final test run.`,
  {
    key: "repair-until-green",
    model: "gpt-5.6-sol",
    sandbox: "workspace-write",
    timeoutMs: 30 * 60 * 1_000,
  },
);
```

Wiff creates a native Codex thread goal from the text after `/goal`, runs the first turn, and
continues on the same thread while the goal remains `active`. The surrounding workflow does not
advance to its next statement or phase until the worker marks the goal `complete`. A `blocked`,
`paused`, `usageLimited`, or `budgetLimited` goal fails the agent stage explicitly. Cancellation
and `timeoutMs` still stop the whole stage.

`/goal` stages currently require the Codex backend. Wiff rejects the directive when `provider`
or the model routes the agent to Claude, Cursor, or Kimi. Use a stable `key` as usual: a completed
goal replays from cache, while an interrupted goal starts a fresh Codex thread with Wiff's
mid-turn progress digest and reuses its dirty worktree when applicable.

## Backends

Agents run on a pluggable backend selected per call: explicit `provider` option, else the
`model` prefix, else `WIFF_BACKEND` (defaults to `codex`). Mixed-backend workflows just work —
`model` is part of the cache key, so resume semantics are identical across backends.

- **codex** — native Codex threads over one long-lived `codex app-server` process. Before launch,
  Wiff disables Codex plugins/apps, enumerates the remaining configured MCP servers, and disables
  each one for the child app-server only. This avoids recursive/duplicated MCP process trees
  without changing interactive Codex configuration. `sandbox` is OS-enforced; `schema` uses
  native structured output. Requires Codex CLI >= 0.144.6. A `-fast` model suffix
  (`gpt-5.6-sol-fast`, `gpt-5.6-sol-xhigh-fast`) requests Codex Fast mode by sending
  `serviceTier: "priority"` on `turn/start`.
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
  and `danger-full-access` disables the sandbox. `grok-*` models (including `cursor-grok-*`
  slugs) receive `effort` as Cursor `model.params`; Composer still ignores `effort`.
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
