export const meta = {
  name: "verify-and-fix",
  description: "Verify findings in parallel, then implement confirmed fixes sequentially",
  phases: [
    { title: "Verify", detail: "Check each finding against the code" },
    { title: "Fix", detail: "Implement confirmed findings" },
  ],
};

const verdictSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["fix", "reject"] },
    rationale: { type: "string" },
  },
  required: ["verdict", "rationale"],
  additionalProperties: false,
};

const findings = args.findings ?? [];

phase("Verify");

const verdicts = await parallel(
  findings.map((finding) => () =>
    agent(`Verify this finding against the current code:\n${finding.text}`, {
      key: `verify:${finding.id}`,
      label: `verify:${finding.id}`,
      model: "gpt-5.6-sol",
      effort: "xhigh",
      sandbox: "read-only",
      schema: verdictSchema,
    }),
  ),
  { concurrency: 8 },
);

const confirmed = findings.filter(
  (_, index) => verdicts[index].verdict === "fix",
);

phase("Fix");

const fixes = await pipeline(
  confirmed,
  (finding) =>
    agent(`Implement this confirmed fix:\n${finding.text}`, {
      key: `fix:${finding.id}`,
      label: `fix:${finding.id}`,
      model: "gpt-5.6-sol",
      effort: "high",
      sandbox: "workspace-write",
    }),
  { concurrency: 1 },
);

return { verdicts, fixes };
