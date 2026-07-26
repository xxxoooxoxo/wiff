import { readFile } from "node:fs/promises";
import path from "node:path";
import { hashText, hashValue, isPlainObject, jsonClone } from "./util.mjs";

const MAX_CONFIG_BYTES = 256 * 1024;
const TOP_LEVEL_KEYS = new Set(["version", "instructions", "defaults", "rules"]);
const OPTION_KEYS = new Set([
  "model",
  "provider",
  "effort",
  "sandbox",
  "timeoutMs",
  "isolation",
  "fallbackModels",
]);
const RULE_KEYS = new Set(["name", "when", "instructions", "goal", "options"]);
const WHEN_KEYS = new Set(["phase", "key", "promptIncludes"]);

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown key "${key}".`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function stringList(value, label) {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must be a non-empty string or array of strings.`);
  }
  return values.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
}

function validateOptions(value, label) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  assertKnownKeys(value, OPTION_KEYS, label);
  const options = jsonClone(value, label);
  for (const key of ["model", "provider", "effort", "sandbox", "isolation"]) {
    if (options[key] !== undefined) options[key] = nonEmptyString(options[key], `${label}.${key}`);
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000)
  ) {
    throw new Error(`${label}.timeoutMs must be an integer of at least 1000.`);
  }
  if (options.fallbackModels !== undefined) {
    options.fallbackModels = stringList(options.fallbackModels, `${label}.fallbackModels`);
  }
  return options;
}

function validateWhen(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  assertKnownKeys(value, WHEN_KEYS, label);
  const when = {};
  if (value.phase !== undefined) when.phase = stringList(value.phase, `${label}.phase`);
  if (value.key !== undefined) when.key = stringList(value.key, `${label}.key`);
  if (value.promptIncludes !== undefined) {
    when.promptIncludes = stringList(value.promptIncludes, `${label}.promptIncludes`);
  }
  return when;
}

function validateRule(value, index, sourcePath) {
  const label = `${sourcePath} rules[${index}]`;
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  assertKnownKeys(value, RULE_KEYS, label);
  const rule = {
    name: value.name === undefined ? `rule-${index + 1}` : nonEmptyString(value.name, `${label}.name`),
    when: validateWhen(value.when ?? {}, `${label}.when`),
    options: validateOptions(value.options, `${label}.options`),
    sourcePath,
  };
  if (value.instructions !== undefined) {
    rule.instructions = nonEmptyString(value.instructions, `${label}.instructions`);
  }
  if (value.goal !== undefined) {
    if (typeof value.goal !== "boolean" && typeof value.goal !== "string") {
      throw new Error(`${label}.goal must be a boolean or non-empty completion-condition string.`);
    }
    rule.goal =
      typeof value.goal === "string"
        ? nonEmptyString(value.goal, `${label}.goal`)
        : value.goal;
  }
  return rule;
}

function validateConfig(value, sourcePath) {
  if (!isPlainObject(value)) throw new Error(`${sourcePath} must contain a JSON object.`);
  assertKnownKeys(value, TOP_LEVEL_KEYS, sourcePath);
  if (value.version !== undefined && value.version !== 1) {
    throw new Error(`${sourcePath} version must be 1.`);
  }
  if (value.rules !== undefined && !Array.isArray(value.rules)) {
    throw new Error(`${sourcePath} rules must be an array.`);
  }
  return {
    instructions:
      value.instructions === undefined
        ? undefined
        : nonEmptyString(value.instructions, `${sourcePath} instructions`),
    defaults: validateOptions(value.defaults, `${sourcePath} defaults`),
    rules: (value.rules ?? []).map((rule, index) => validateRule(rule, index, sourcePath)),
  };
}

async function readConfig(sourcePath) {
  let text;
  try {
    text = await readFile(sourcePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error(`${sourcePath} exceeds ${MAX_CONFIG_BYTES} bytes.`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid Wiff config JSON at ${sourcePath}: ${error.message}`);
  }
  return {
    config: validateConfig(value, sourcePath),
    source: { path: sourcePath, hash: hashText(text) },
  };
}

export async function loadWorkflowPreferences({ stateRoot, cwd }) {
  const candidates = [
    path.join(stateRoot, "config.json"),
    path.join(cwd, ".wiff", "config.json"),
  ];
  const loaded = [];
  for (const candidate of [...new Set(candidates)]) {
    const entry = await readConfig(candidate);
    if (entry) loaded.push(entry);
  }
  return {
    instructions: loaded.map(({ config }) => config.instructions).filter(Boolean),
    defaults: Object.assign({}, ...loaded.map(({ config }) => config.defaults)),
    rules: loaded.flatMap(({ config }) => config.rules),
    sources: loaded.map(({ source }) => source),
  };
}

function matchesRule(rule, { phase, key, prompt }) {
  const phaseMatch =
    rule.when.phase === undefined ||
    rule.when.phase.some((candidate) => candidate.toLowerCase() === phase.toLowerCase());
  const keyMatch = rule.when.key === undefined || rule.when.key.includes(key);
  const normalizedPrompt = prompt.toLowerCase();
  const promptMatch =
    rule.when.promptIncludes === undefined ||
    rule.when.promptIncludes.some((candidate) =>
      normalizedPrompt.includes(candidate.toLowerCase()),
    );
  return phaseMatch && keyMatch && promptMatch;
}

function goalPrompt(prompt, goal) {
  if (!goal) return prompt;
  const alreadyGoal = /^\s*\/goal(?:\s|$)/.test(prompt);
  if (goal === true) return alreadyGoal ? prompt : `/goal ${prompt}`;
  const condition = `Configured completion condition: ${goal}`;
  return alreadyGoal ? `${prompt}\n\n${condition}` : `/goal ${prompt}\n\n${condition}`;
}

export function applyWorkflowPreferences(
  preferences,
  { phase, key, prompt, inputOptions },
) {
  const options = { ...preferences.defaults, ...inputOptions };
  const instructionParts = [...preferences.instructions];
  const matchedRules = [];
  let goal = false;

  for (const rule of preferences.rules) {
    if (!matchesRule(rule, { phase, key, prompt })) continue;
    Object.assign(options, rule.options);
    if (rule.instructions) instructionParts.push(rule.instructions);
    if (rule.goal !== undefined) goal = rule.goal;
    matchedRules.push(`${rule.sourcePath}#${rule.name}`);
  }

  const preferredPrompt = goalPrompt(prompt, goal);
  const instructions =
    instructionParts.length === 0
      ? undefined
      : [
          "The following preferences were explicitly provided by the user in Wiff configuration.",
          "Apply them in addition to the agent task:",
          "",
          instructionParts.join("\n\n"),
        ].join("\n");
  if (
    instructions !== undefined ||
    preferredPrompt !== prompt ||
    matchedRules.length > 0 ||
    Object.keys(preferences.defaults).length > 0
  ) {
    options.preferenceHash = hashValue({
      instructions,
      goal,
      matchedRules,
      preferredPrompt,
    });
  }

  return { options, prompt: preferredPrompt, instructions, matchedRules };
}
