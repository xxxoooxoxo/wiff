import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyWorkflowPreferences,
  loadWorkflowPreferences,
} from "../src/preferences.mjs";

test("loads user and project preferences with explicit precedence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiff-preferences-"));
  const stateRoot = path.join(root, "state");
  const cwd = path.join(root, "project");
  await mkdir(path.join(cwd, ".wiff"), { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  try {
    await writeFile(
      path.join(stateRoot, "config.json"),
      JSON.stringify({
        version: 1,
        instructions: "Use concise evidence.",
        defaults: {
          model: "claude-opus-5",
          fallbackModels: ["claude-sonnet-5"],
        },
        rules: [
          {
            name: "review-depth",
            when: { phase: "Review" },
            instructions: "Review adversarially.",
            options: { effort: "high" },
          },
        ],
      }),
    );
    await writeFile(
      path.join(cwd, ".wiff", "config.json"),
      JSON.stringify({
        version: 1,
        instructions: "Respect this repository's contracts.",
        defaults: { effort: "medium" },
        rules: [
          {
            name: "auth-goal",
            when: { phase: ["Review"], promptIncludes: ["auth"] },
            goal: "Do not finish until authorization behavior is verified.",
            options: {
              model: "gpt-5.6-sol",
              fallbackModels: ["claude-opus-5"],
            },
          },
        ],
      }),
    );

    const preferences = await loadWorkflowPreferences({ stateRoot, cwd });
    const applied = applyWorkflowPreferences(preferences, {
      phase: "Review",
      key: "auth-review",
      prompt: "Review the auth boundary",
      inputOptions: { model: "claude-sonnet-5", key: "auth-review" },
    });

    assert.equal(applied.options.model, "gpt-5.6-sol", "matching rule overrides the call");
    assert.equal(applied.options.effort, "high", "user rule overrides project default");
    assert.deepEqual(applied.options.fallbackModels, ["claude-opus-5"]);
    assert.match(applied.prompt, /^\/goal Review the auth boundary/);
    assert.match(applied.prompt, /authorization behavior is verified/);
    assert.match(applied.instructions, /Use concise evidence/);
    assert.match(applied.instructions, /Respect this repository/);
    assert.match(applied.instructions, /Review adversarially/);
    assert.equal(applied.matchedRules.length, 2);
    assert.equal(preferences.sources.length, 2);
    assert.ok(applied.options.preferenceHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unknown preference keys instead of silently ignoring typos", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiff-preferences-invalid-"));
  const stateRoot = path.join(root, "state");
  const cwd = path.join(root, "project");
  await mkdir(stateRoot, { recursive: true });
  await mkdir(cwd, { recursive: true });
  try {
    await writeFile(
      path.join(stateRoot, "config.json"),
      JSON.stringify({ version: 1, defualts: { model: "opus" } }),
    );
    await assert.rejects(
      loadWorkflowPreferences({ stateRoot, cwd }),
      /unknown key "defualts"/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
