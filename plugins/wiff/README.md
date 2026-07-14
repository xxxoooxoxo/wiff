# wiff

Deterministic, resumable multi-agent workflows for [Codex](https://github.com/openai/codex),
exposed as a harness-agnostic MCP server. Write plain JavaScript with `agent()`, `parallel()`,
and `pipeline()`; wiff runs the children on Codex, journals every step, and resumes interrupted
runs without re-paying for completed work.

Run the server (any MCP client):

```sh
npx wiff            # stdio MCP server: workflow_start / status / wait / cancel
npx wiff-viewer     # live web viewer on http://127.0.0.1:4979
```

Requires the `codex` CLI installed and authenticated, Node >= 22, and git for
`isolation: "worktree"`.

Full documentation, the workflow script contract, and Codex/Claude Code plugin installs:
**https://github.com/xxxoooxoxo/wiff**
