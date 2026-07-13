import assert from "node:assert/strict";
import test from "node:test";
import { transformWorkflowSource, validateWorkflowSource } from "../src/workflow-source.mjs";

test("transforms Claude-style metadata and permits top-level return", () => {
  const source = `
    export const meta = {
      name: "example;still-string",
      description: "A workflow",
    };
    return 42;
  `;
  const transformed = transformWorkflowSource(source);
  assert.match(transformed, /const meta = __setMeta\(/);
  assert.match(transformed, /return 42/);
  assert.doesNotThrow(() => validateWorkflowSource(source));
});

test("requires literal exported metadata", () => {
  assert.throws(() => validateWorkflowSource("return 1;"), /export const meta/);
  assert.throws(
    () => validateWorkflowSource('const decoy = "export const meta = {};"; return 1;'),
    /export const meta/,
  );
  assert.throws(
    () =>
      validateWorkflowSource(`
        const before = true;
        export const meta = { name: "late", description: "late" };
      `),
    /export const meta/,
  );
});

test("rejects additional exports", () => {
  assert.throws(
    () =>
      validateWorkflowSource(`
        export const meta = { name: "bad", description: "bad" };
        export const other = 1;
        return other;
      `),
    /Only `export const meta`/,
  );
});

test("allows comments before metadata and export text inside strings", () => {
  assert.doesNotThrow(() =>
    validateWorkflowSource(`
      // export const meta = { decoy: true };
      /* workflow metadata follows */
      export const meta = { name: "strings", description: "strings" };
      const text = "export const harmless = true";
      return text;
    `),
  );
});
