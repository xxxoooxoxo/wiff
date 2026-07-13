import vm from "node:vm";

const META_PATTERN = /^\s*export\s+const\s+meta\s*=/;

function maskStringsAndComments(source) {
  const masked = source.split("");
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      else masked[index] = " ";
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        masked[index] = " ";
        masked[index + 1] = " ";
        blockComment = false;
        index += 1;
      } else if (char !== "\n") {
        masked[index] = " ";
      }
      continue;
    }
    if (quote) {
      if (char !== "\n") masked[index] = " ";
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      masked[index] = " ";
      masked[index + 1] = " ";
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      masked[index] = " ";
      masked[index + 1] = " ";
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      masked[index] = " ";
      quote = char;
    }
  }
  return masked.join("");
}

function findExpressionTerminator(source, start) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    if (char === ")" || char === "]" || char === "}") depth -= 1;
    if (depth < 0) throw new Error("Unbalanced metadata expression.");
    if (char === ";" && depth === 0) return index;
  }
  throw new Error("Workflow metadata declaration must end with a semicolon.");
}

export function transformWorkflowSource(source) {
  const maskedSource = maskStringsAndComments(source);
  const match = META_PATTERN.exec(maskedSource);
  if (!match) {
    throw new Error("Workflow must begin with `export const meta = { ... };`.");
  }
  const declarationStart = maskedSource.indexOf("export", match.index);
  const equalsIndex = maskedSource.indexOf("=", declarationStart);
  const expressionStart = equalsIndex + 1;
  const terminator = findExpressionTerminator(source, expressionStart);
  const expression = source.slice(expressionStart, terminator).trim();
  if (!expression) throw new Error("Workflow metadata cannot be empty.");

  const transformed = [
    source.slice(0, declarationStart),
    "const meta = __setMeta(",
    expression,
    ");",
    source.slice(terminator + 1),
  ].join("");

  if (/\bexport\s+/.test(maskStringsAndComments(transformed))) {
    throw new Error("Only `export const meta` is supported in workflow scripts.");
  }
  return transformed;
}

export function wrapWorkflowSource(source) {
  const transformed = transformWorkflowSource(source);
  return `"use strict";\n(async () => {\n${transformed}\n})()`;
}

export function validateWorkflowSource(source) {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new Error("Workflow script must be a non-empty string.");
  }
  const wrapped = wrapWorkflowSource(source);
  new vm.Script(wrapped, { filename: "workflow.js" });
  return wrapped;
}
