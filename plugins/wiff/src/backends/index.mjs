import { ClaudeBackend } from "./claude.mjs";
import { CodexBackend } from "./codex.mjs";
import { CursorBackend } from "./cursor.mjs";
import { KimiBackend } from "./kimi.mjs";

/**
 * Backend contract
 * ----------------
 * A backend runs one workflow agent per call and streams its lifecycle back to
 * the runtime. The runtime owns journaling, caching, worktrees, timeouts, and
 * concurrency; a backend only has to run a turn.
 *
 *   runAgent({ prompt, options, instructions, signal, onEvent })
 *     -> Promise<{ result, threadId, turnId, usage }>
 *
 *   prompt        Final prompt text (may include a resume preamble).
 *   options       Normalized agent options: { model, effort, sandbox, cwd,
 *                 schema?, isolation?, provider?, ... }. cwd already points at
 *                 the agent's worktree when isolation is "worktree".
 *   instructions  Optional persona instructions (agentType body).
 *   signal        AbortSignal; abort by interrupting the turn and rejecting
 *                 with signal.reason.
 *   onEvent       Optional transcript sink. Events must use the Codex
 *                 app-server notification shape ({ method, params }) so the
 *                 journal digests and the viewer render identically across
 *                 backends. Emit `workflow/agentThreadStarted` once a thread
 *                 id exists, and `item/completed` items of type agentMessage /
 *                 commandExecution / fileChange / reasoning / webSearch /
 *                 toolCall for activity.
 *
 *   result        Final message text, or parsed JSON when options.schema set.
 *   threadId      Backend-native conversation id (thread id, session id, ...).
 *   turnId        Backend-native turn id, if any.
 *   usage         Token usage; normalize to { total: { totalTokens, ... } }.
 *
 *   close()       Optional. Tear down long-lived processes and reject
 *                 in-flight turns.
 *
 *   listModels()  Optional. Resolve to [{ id, displayName?, description?,
 *                 efforts?, defaultEffort?, isDefault?, note? }] describing
 *                 the models this backend can run, for discovery/validation.
 *
 * A backend must not depend on process-global mutable state keyed by run:
 * one instance serves every concurrent workflow of a WorkflowManager.
 */

const PROVIDER_FACTORIES = {
  codex: () => new CodexBackend(),
  claude: () => new ClaudeBackend(),
  cursor: () => new CursorBackend(),
  kimi: () => new KimiBackend(),
};

const MODEL_PROVIDER_PATTERNS = [
  [/^(claude|opus|sonnet|haiku|fable)/i, "claude"],
  [/^(gpt|codex|o\d)/i, "codex"],
  [/^(composer|cursor)/i, "cursor"],
  [/^kimi/i, "kimi"],
  [/^gemini/i, "gemini"],
];

// Map a model name to its provider, or null when the prefix is unrecognized.
export function inferProvider(model) {
  if (typeof model !== "string") return null;
  for (const [pattern, provider] of MODEL_PROVIDER_PATTERNS) {
    if (pattern.test(model.trim())) return provider;
  }
  return null;
}

function defaultProviderFromEnv() {
  const configured = process.env.WIFF_BACKEND?.trim();
  return configured ? configured.toLowerCase() : "codex";
}

/**
 * Routing backend: picks a concrete provider per agent call and lazily
 * instantiates one backend per provider.
 *
 * Provider resolution order:
 *   1. options.provider (explicit per-agent or persona override)
 *   2. options.model prefix (gpt-*\/o* -> codex, claude-*\/opus\/... -> claude,
 *      composer-* -> cursor, kimi-code/* -> kimi)
 *   3. WIFF_BACKEND environment variable
 *   4. "codex"
 */
export class BackendRouter {
  #backends = new Map();
  #factories;

  constructor({ defaultProvider, factories } = {}) {
    this.defaultProvider = (defaultProvider ?? defaultProviderFromEnv()).toLowerCase();
    this.#factories = factories ?? PROVIDER_FACTORIES;
    if (typeof this.#factories[this.defaultProvider] !== "function") {
      throw new Error(
        `Unknown workflow backend "${this.defaultProvider}". Known backends: ${Object.keys(this.#factories).join(", ")}.`,
      );
    }
  }

  providerFor(options) {
    return (
      options?.provider?.toLowerCase() ??
      inferProvider(options?.model) ??
      this.defaultProvider
    );
  }

  backendFor(provider) {
    const existing = this.#backends.get(provider);
    if (existing) return existing;
    const factory = this.#factories[provider];
    if (typeof factory !== "function") {
      throw new Error(
        `No backend registered for provider "${provider}". Known backends: ${Object.keys(this.#factories).join(", ")}. ` +
          "Pass a supported provider option or model, or set WIFF_BACKEND.",
      );
    }
    const backend = factory();
    this.#backends.set(provider, backend);
    return backend;
  }

  async runAgent(request) {
    return this.backendFor(this.providerFor(request.options)).runAgent(request);
  }

  // Model catalog per provider: { codex: { models: [...] } | { error }, ... }.
  // A provider that is unavailable (CLI missing, SDK not installed, no auth)
  // reports its error instead of failing the whole listing.
  async listModels() {
    const providers = Object.keys(this.#factories);
    const listings = await Promise.all(
      providers.map(async (provider) => {
        try {
          const models = await this.backendFor(provider).listModels?.();
          return [provider, { models: models ?? [] }];
        } catch (error) {
          return [provider, { error: error?.message ?? String(error) }];
        }
      }),
    );
    return Object.fromEntries(listings);
  }

  async close() {
    const backends = [...this.#backends.values()];
    this.#backends.clear();
    await Promise.allSettled(backends.map((backend) => backend.close?.()));
  }
}

export { ClaudeBackend } from "./claude.mjs";
export { CodexBackend, AppServerClient } from "./codex.mjs";
export { CursorBackend } from "./cursor.mjs";
export { KimiBackend } from "./kimi.mjs";
