# Codex Workflows

A local Codex plugin for deterministic, resumable JavaScript workflows that orchestrate Codex agents.

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

Start a new Codex task after installation. Invoke the bundled skill with `$workflow`, or ask Codex to run a task as a resumable workflow.

Installing the plugin auto-approves its four local workflow-controller tools so headless and desktop runs do not stop at an MCP approval prompt. Agent filesystem access is still controlled independently by each call's `sandbox` option; keep analysis agents read-only and serialize agents that write to one checkout.

## Workflow shape

```js
export const meta = {
  name: "audit",
  description: "Audit files in parallel",
  phases: [{ title: "Audit", detail: "Inspect each target" }],
};

phase("Audit");
const results = await parallel(
  args.files.map((file) => () =>
    agent(`Audit ${file}`, {
      key: `audit:${file}`,
      model: "gpt-5.6-sol",
      effort: "xhigh",
      sandbox: "read-only",
    }),
  ),
);
return results;
```

See [`examples/verify-and-fix.js`](plugins/codex-workflows/examples/verify-and-fix.js) for a staged example.

## Runtime behavior

- `parallel()` and `pipeline()` fail hard when an agent rejects.
- `parallelSettled()` is the explicit partial-failure escape hatch.
- Stable agent keys allow successful unchanged calls to replay on resume.
- Status, waits, and cancellation work across Codex MCP host restarts.
- Parallel read-only agents share the run checkout; concurrent write agents should use
  `isolation: "worktree"`, which gives each agent a fresh git worktree, removes clean ones,
  and keeps dirty ones listed in the run's `worktrees` array for harvest.
- `agentType: "<name>"` injects a persona (`<cwd>/.codex/agents/<name>.md` or
  `~/.codex/agents/<name>.md`) as the child's developer instructions; frontmatter `model`,
  `effort`, and `sandbox` act as defaults.
- Workflow code cannot directly import modules or use filesystem, shell, time, randomness, or fetch APIs.
- Runs persist under `~/.codex/workflows/runs/<runId>/` by default.

The plugin exposes `workflow_start`, `workflow_status`, `workflow_wait`, and `workflow_cancel` over MCP. It uses one local `codex app-server` process for child threads and disables recursive workflow/multi-agent orchestration inside those children.

## Validate

```sh
cd plugins/codex-workflows
npm test
npm run check
npm run smoke
```

Pass a completed smoke run id to verify cross-process resume without another model call:

```sh
npm run smoke -- wf_<run-id>
```
