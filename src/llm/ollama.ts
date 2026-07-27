/**
 * The only module allowed to talk to LLM providers.
 *
 * Default modes stay on localhost. Cloud modes are deliberately narrow:
 * OpenAI and Anthropic have fixed official endpoints, require an explicit
 * acknowledgement, and never receive a request through an implicit fallback.
 */
import { getPref } from "../utils/prefs";

export interface OllamaStatus {
  ok: boolean;
  version?: string;
  models: string[];
  error?: string;
}

// One HTTP transport (OpenAI-compatible /v1/chat/completions) for every local
// or cloud endpoint, plus two subscription-login CLIs run as subprocesses.
type ApiType = "openai-compatible" | "codex-app-server" | "claude-code";

interface RequestOptions {
  headers?: Record<string, string>;
  timeout?: number;
  /** Use the server root (no /v1) — for Ollama's native /api endpoints. */
  native?: boolean;
}

function apiType(): ApiType {
  const value = String(getPref("apiType") || "openai-compatible");
  if (value === "codex-app-server" || value === "claude-code") return value;
  // Legacy provider names (ollama / openai / openai-api / anthropic) all use
  // the OpenAI-compatible transport now.
  return "openai-compatible";
}

export function providerLabel(): string {
  switch (apiType()) {
    case "codex-app-server":
      return "Codex App Server";
    case "claude-code":
      return "Claude Code";
    default:
      return "OpenAI-compatible";
  }
}

/**
 * Name for the endpoint actually configured, for status messages. The generic
 * "OpenAI-compatible" transport fronts very different servers, so identify the
 * real one where the URL makes it obvious rather than always saying Ollama (or
 * always saying OpenAI-compatible).
 */
export function providerDisplayName(): string {
  const type = apiType();
  if (type !== "openai-compatible") return providerLabel();
  const url = baseUrl(true).toLowerCase();
  if (url.includes(":11434")) return "Ollama";
  if (url.includes("api.openai.com")) return "OpenAI";
  if (url.includes("api.anthropic.com")) return "Anthropic";
  if (url.includes("openrouter.ai")) return "OpenRouter";
  if (url.includes(":1234")) return "LM Studio";
  if (url.includes("localhost") || url.includes("127.0.0.1")) {
    return "Local server";
  }
  return "OpenAI-compatible server";
}

/** What to try when the configured endpoint does not answer. */
export function connectionHint(): string {
  switch (apiType()) {
    case "codex-app-server":
      return "check the Codex CLI path in Settings";
    case "claude-code":
      return 'run "claude login", then check the CLI path in Settings';
    default:
      return baseUrl(true).includes(":11434")
        ? 'start it with "ollama serve"'
        : "check the server URL in Settings";
  }
}

/** Providers that run a local CLI subprocess instead of an HTTP endpoint. */
function isSubprocessProvider(): boolean {
  return apiType() === "codex-app-server" || apiType() === "claude-code";
}

/**
 * Endpoint base URL. `native` returns the server root (for Ollama's /api/*),
 * otherwise the OpenAI-compatible /v1 base (adding /v1, tolerating a stray one).
 */
function baseUrl(native = false): string {
  const url = String(getPref("ollamaUrl") || "http://localhost:11434").replace(
    /\/+$/,
    "",
  );
  const root = url.replace(/\/v1$/, "");
  return native ? root : /\/v1$/.test(url) ? url : `${root}/v1`;
}

/** Ollama context length to request via the native API; 0 = server default. */
function ollamaNumCtx(): number {
  return Math.max(0, Math.floor(Number(getPref("ollamaNumCtx")) || 0));
}

function isLocalHost(url: string): boolean {
  const host = url.replace(/^https?:\/\//, "").split(/[/:]/)[0];
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
}

/** Consent gate for anything that sends text off this computer. */
function requireConsent(): void {
  if (!getPref("cloudConsent")) {
    throw new Error(
      "This endpoint sends text off your computer. Enable the cloud-consent checkbox in SkimRead settings first.",
    );
  }
}

async function request(
  method: "GET" | "POST",
  path: string,
  body?: object,
  options: RequestOptions = {},
): Promise<unknown> {
  const url = `${baseUrl(options.native)}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  // Localhost needs no key or consent. A remote endpoint (OpenRouter, hosted
  // vLLM, OpenAI, Anthropic, Gemini) sends text off-machine, so it requires an
  // API key and explicit cloud consent.
  if (!isLocalHost(url)) requireConsent();
  const key = String(getPref("openaiCompatibleKey") || "").trim();
  if (key) headers.Authorization = `Bearer ${key}`;

  const xhr = await Zotero.HTTP.request(method, url, {
    headers,
    body: body ? JSON.stringify(body) : undefined,
    timeout: options.timeout ?? 120000,
    responseType: "text",
  });
  return JSON.parse(xhr.response) as unknown;
}

/** The subprocess providers use one model for all reader tasks. */
export function modelForProvider(configuredModel: string): string {
  if (apiType() === "codex-app-server") {
    return String(getPref("codexModel") || "").trim();
  }
  if (apiType() === "claude-code") {
    return String(getPref("claudeModel") || "").trim();
  }
  return configuredModel.trim();
}

/**
 * Remove reasoning blocks. Thinking models (Qwen3, R1 distills, and anything
 * with `<think>` in its chat template) emit their reasoning before the answer,
 * and that reasoning frequently contains braces — often a draft of the very
 * JSON being asked for. Left in place it derails brace-matched extraction.
 */
export function stripThinking(raw: string): string {
  let out = raw.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, " ");
  // A stray closer means the opener was never emitted (some servers strip it):
  // whatever follows the last closer is the answer.
  const lastClose = out.toLowerCase().lastIndexOf("</think>");
  if (lastClose >= 0) out = out.slice(lastClose + "</think>".length);
  return out.trim();
}

/**
 * Parse JSON a model may have wrapped in reasoning, prose, or code fences.
 * Strips thinking, tries a strict parse, then falls back to balanced-brace
 * extraction (string- and escape-aware), preferring the last valid candidate.
 */
export function parseLooseJSON(raw: string): unknown {
  const trimmed = stripThinking(raw);
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to tolerant extraction
  }
  // Collect every balanced top-level candidate, then prefer the LAST one that
  // parses. Reasoning that survived stripping tends to precede the real answer,
  // and a model that drafts JSON while thinking would otherwise win.
  const candidates: string[] = [];
  let start = -1;
  let open = "{";
  let close = "}";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (start < 0) {
      if (ch === "{" || ch === "[") {
        start = i;
        open = ch;
        close = ch === "{" ? "}" : "]";
        depth = 1;
      }
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        candidates.push(trimmed.slice(start, i + 1));
        start = -1;
      }
    }
  }
  if (!candidates.length) {
    throw new Error(
      start >= 0
        ? "Incomplete JSON in the model response"
        : "No JSON found in the model response",
    );
  }
  let lastError: unknown = null;
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(candidates[i]);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("No parsable JSON in the model response");
}

interface CodexPipe {
  readString(): Promise<string>;
}

interface CodexSubprocess {
  stdin: { write(value: string): void | Promise<unknown>; close?(): void };
  stdout: CodexPipe;
  stderr?: CodexPipe;
  kill(): void;
}

interface CodexSubprocessModule {
  call(options: {
    command: string;
    arguments: string[];
    stderr: "pipe";
  }): Promise<CodexSubprocess>;
}

interface PendingCodexRequest {
  resolve(value: unknown): void;
  reject(reason: Error): void;
}

type CodexNotification = (params: unknown) => void;

function isCodexSubprocessModule(
  value: unknown,
): value is CodexSubprocessModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { call?: unknown }).call === "function"
  );
}

async function loadCodexSubprocess(): Promise<CodexSubprocessModule> {
  const chrome = globalThis as typeof globalThis & {
    ChromeUtils?: {
      importESModule?(url: string): unknown;
      import?(url: string): unknown;
    };
  };
  const module = chrome.ChromeUtils?.importESModule?.(
    "resource://gre/modules/Subprocess.sys.mjs",
  );
  if (isCodexSubprocessModule(module)) return module;
  if (
    typeof module === "object" &&
    module !== null &&
    isCodexSubprocessModule((module as { Subprocess?: unknown }).Subprocess)
  ) {
    return (module as { Subprocess: CodexSubprocessModule }).Subprocess;
  }
  const legacy = chrome.ChromeUtils?.import?.(
    "resource://gre/modules/Subprocess.jsm",
  );
  if (isCodexSubprocessModule(legacy)) return legacy;
  if (
    typeof legacy === "object" &&
    legacy !== null &&
    isCodexSubprocessModule((legacy as { Subprocess?: unknown }).Subprocess)
  ) {
    return (legacy as { Subprocess: CodexSubprocessModule }).Subprocess;
  }
  throw new Error("Codex App Server is unavailable in this Zotero runtime.");
}

/**
 * Minimal JSON-RPC client for `codex app-server`. It deliberately creates an
 * ephemeral, tool-free thread per reader run; no Codex conversation or paper
 * content is retained by this plugin after the structured response is cached.
 */
class CodexAppServerClient {
  private nextID = 1;
  private pending = new Map<number, PendingCodexRequest>();
  private notifications = new Map<string, Set<CodexNotification>>();
  private buffer = "";
  private closed = false;

  private constructor(private readonly process: CodexSubprocess) {
    void this.readLoop();
  }

  static async start(): Promise<CodexAppServerClient> {
    const Subprocess = await loadCodexSubprocess();
    const command = await resolveCodexCommand();
    let process: CodexSubprocess;
    try {
      process = await Subprocess.call({
        command,
        arguments: ["app-server"],
        stderr: "pipe",
      });
    } catch (error) {
      throw new Error(
        `Could not start Codex App Server (${command}). Run codex login and set the Codex CLI path in SkimRead settings. ${String(error)}`,
      );
    }
    const client = new CodexAppServerClient(process);
    await client.request("initialize", {
      clientInfo: { name: "skimread", version: "0.8.0" },
      capabilities: { experimentalApi: false },
    });
    client.notify("initialized");
    return client;
  }

  request(method: string, params?: object, timeout = 60_000): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new Error("Codex App Server closed"));
    return new Promise((resolve, reject) => {
      const id = this.nextID++;
      const timeoutID = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Codex App Server timed out during ${method}.`));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeoutID);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeoutID);
          reject(error);
        },
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: object): void {
    if (!this.closed) this.write({ method, params });
  }

  on(method: string, callback: CodexNotification): () => void {
    let callbacks = this.notifications.get(method);
    if (!callbacks) {
      callbacks = new Set();
      this.notifications.set(method, callbacks);
    }
    callbacks.add(callback);
    return () => callbacks?.delete(callback);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      request.reject(new Error("Codex App Server closed"));
    }
    this.pending.clear();
    try {
      this.process.kill();
    } catch {
      // The process may already have exited.
    }
  }

  private write(message: Record<string, unknown>): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async readLoop(): Promise<void> {
    try {
      while (!this.closed) {
        const chunk = await this.process.stdout.readString();
        if (!chunk) break;
        this.buffer += chunk;
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";
        for (const line of lines) this.handleLine(line.trim());
      }
    } catch {
      // Pending callers below receive the useful closed-process error.
    }
    if (!this.closed) this.close();
  }

  private handleLine(line: string): void {
    if (!line) return;
    let message: {
      id?: unknown;
      method?: unknown;
      result?: unknown;
      error?: unknown;
      params?: unknown;
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const request = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        const detail =
          typeof message.error === "object" && message.error !== null
            ? (message.error as { message?: unknown }).message
            : message.error;
        request.reject(new Error(String(detail || "Codex App Server error")));
      } else {
        request.resolve(message.result);
      }
      return;
    }
    if (typeof message.id === "number" && typeof message.method === "string") {
      // SkimRead never grants Codex tools, filesystem access, or Zotero MCP.
      this.write({
        id: message.id,
        error: { code: -32601, message: "Tools are disabled in SkimRead." },
      });
      return;
    }
    if (typeof message.method !== "string") return;
    for (const callback of this.notifications.get(message.method) || []) {
      callback(message.params);
    }
  }
}

/**
 * Zotero's subprocess API requires an executable path and does not perform the
 * shell PATH lookup that makes a bare `codex` work in Terminal.
 */
async function resolveCodexCommand(): Promise<string> {
  const configured = String(getPref("codexPath") || "").trim();
  const candidates = [
    configured,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (await IOUtils.exists(candidate)) return candidate;
    } catch {
      // Keep trying the remaining known locations.
    }
  }
  return configured || "codex";
}

// ---------- Claude Code (subscription login via the `claude` CLI) ----------

function homeDir(): string {
  try {
    const services = (globalThis as { Services?: unknown }).Services as {
      dirsvc?: { get(prop: string, type: unknown): { path?: string } };
    };
    const ci = (globalThis as { Ci?: { nsIFile?: unknown } }).Ci;
    const file = services?.dirsvc?.get("Home", ci?.nsIFile);
    return typeof file?.path === "string" ? file.path : "";
  } catch {
    return "";
  }
}

async function resolveClaudeCommand(): Promise<string> {
  const configured = String(getPref("claudePath") || "").trim();
  const home = homeDir();
  const candidates = [
    configured,
    home ? PathUtils.join(home, ".local", "bin", "claude") : "",
    home ? PathUtils.join(home, ".claude", "local", "claude") : "",
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (await IOUtils.exists(candidate)) return candidate;
    } catch {
      // Keep trying the remaining known locations.
    }
  }
  return configured || "claude";
}

/**
 * One-shot structured call through the local `claude` CLI in headless print
 * mode. Authentication is whatever `claude` is already logged into (a Claude
 * Pro/Max subscription); no API key is read or stored. Tools are disabled so
 * Claude cannot touch the filesystem or run commands — it only returns text.
 */
async function claudeCodeJSON(opts: {
  model: string;
  system: string;
  user: string;
}): Promise<unknown> {
  requireConsent();
  const model = modelForProvider(opts.model);
  if (!model) throw new Error("Enter a Claude model in SkimRead settings.");
  const Subprocess = await loadCodexSubprocess();
  const command = await resolveClaudeCommand();
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--append-system-prompt",
    `${opts.system}\n\nReturn only the requested JSON. Do not use tools, read files, run commands, or add commentary.`,
    "--allowedTools",
    "",
  ];
  let process: CodexSubprocess;
  try {
    process = await Subprocess.call({
      command,
      arguments: args,
      stderr: "pipe",
    });
  } catch (error) {
    throw new Error(
      `Could not start Claude Code (${command}). Install Claude Code, run claude login, and set the Claude CLI path in SkimRead settings. ${String(error)}`,
    );
  }
  try {
    // Feed the prompt on stdin in chunks so a large document cannot deadlock
    // the pipe, then close stdin to signal end-of-input.
    const CHUNK = 32000;
    for (let i = 0; i < opts.user.length; i += CHUNK) {
      await process.stdin.write(opts.user.slice(i, i + CHUNK));
    }
    process.stdin.close?.();
    let out = "";
    for (;;) {
      const chunk = await process.stdout.readString();
      if (!chunk) break;
      out += chunk;
    }
    // The CLI may emit an update notice before the JSON envelope; extract it
    // tolerantly rather than parsing the whole stdout.
    const envelope = parseLooseJSON(out) as {
      result?: unknown;
      is_error?: unknown;
      error?: unknown;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    recordUsage(envelope.usage?.input_tokens, envelope.usage?.output_tokens);
    if (envelope.is_error) {
      // The CLI puts the human-readable reason (e.g. "Not logged in · Please
      // run /login") in `result`; prefer it over a generic message.
      throw new Error(
        String(
          envelope.result || envelope.error || "Claude Code reported an error",
        ),
      );
    }
    const text = envelope.result;
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("Claude Code returned no result");
    }
    // The model's text may include prose or code fences around the JSON.
    return parseLooseJSON(text);
  } finally {
    try {
      process.kill();
    } catch {
      // Already exited.
    }
  }
}

async function claudeVersion(): Promise<string> {
  const Subprocess = await loadCodexSubprocess();
  const command = await resolveClaudeCommand();
  const process = await Subprocess.call({
    command,
    arguments: ["--version"],
    stderr: "pipe",
  });
  let out = "";
  for (;;) {
    const chunk = await process.stdout.readString();
    if (!chunk) break;
    out += chunk;
  }
  return out.trim() || "Claude Code";
}

function responseID(result: unknown, key: "thread" | "turn"): string {
  if (!result || typeof result !== "object") return "";
  const value = result as {
    id?: unknown;
    thread?: { id?: unknown };
    turn?: { id?: unknown };
  };
  const id = value.id || value[key]?.id;
  return typeof id === "string" ? id : "";
}

function notificationTurnID(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const value = params as { turnId?: unknown; turn?: { id?: unknown } };
  const id = value.turnId || value.turn?.id;
  return typeof id === "string" ? id : "";
}

async function waitForCodexTurn(
  client: CodexAppServerClient,
  turnID: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const cleanup = () => {
      clearTimeout(timeout);
      removeDelta();
      removeCompleted();
    };
    const complete = (result: string) => {
      cleanup();
      resolve(result);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(
      () => fail(new Error("Codex selection timed out.")),
      300_000,
    );
    const removeDelta = client.on("item/agentMessage/delta", (params) => {
      if (notificationTurnID(params) !== turnID) return;
      const value = params as { delta?: unknown; text?: unknown };
      const delta = value.delta || value.text;
      if (typeof delta === "string") text += delta;
    });
    const removeCompleted = client.on("turn/completed", (params) => {
      if (notificationTurnID(params) !== turnID) return;
      const value = params as { turn?: { status?: unknown }; status?: unknown };
      const status = value.turn?.status || value.status;
      if (status === "completed") {
        complete(text);
      } else {
        fail(
          new Error(
            `Codex turn ended with status: ${String(status || "unknown")}`,
          ),
        );
      }
    });
  });
}

async function codexJSON(opts: {
  model: string;
  system: string;
  user: string;
  schema: object;
}): Promise<unknown> {
  requireConsent();
  const client = await CodexAppServerClient.start();
  try {
    const model = modelForProvider(opts.model);
    if (!model) throw new Error("Enter a Codex model in SkimRead settings.");
    const thread = await client.request("thread/start", {
      model,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: `${opts.system}\n\nReturn only the requested JSON. Do not call tools, inspect files, use Zotero, or make changes.`,
    });
    const threadID = responseID(thread, "thread");
    if (!threadID)
      throw new Error("Codex App Server did not return a thread ID.");
    const turn = await client.request("turn/start", {
      threadId: threadID,
      model,
      effort: String(getPref("codexReasoning") || "medium"),
      approvalPolicy: "never",
      input: [{ type: "text", text: opts.user }],
      outputSchema: opts.schema,
    });
    const turnID = responseID(turn, "turn");
    if (!turnID) throw new Error("Codex App Server did not return a turn ID.");
    const content = await waitForCodexTurn(client, turnID);
    if (!content)
      throw new Error("Codex App Server returned no message content.");
    return parseLooseJSON(content);
  } finally {
    client.close();
  }
}

function codexModels(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const source = value as { models?: unknown; data?: unknown };
  const models = source.models || source.data;
  if (!Array.isArray(models)) return [];
  return models.flatMap((model) => {
    if (typeof model === "string") return [model];
    if (!model || typeof model !== "object") return [];
    const item = model as { id?: unknown; model?: unknown; slug?: unknown };
    const id = item.id || item.model || item.slug;
    return typeof id === "string" ? [id] : [];
  });
}

/** Check the configured provider (lists models where the endpoint allows). */
export async function checkStatus(): Promise<OllamaStatus> {
  try {
    switch (apiType()) {
      case "codex-app-server": {
        requireConsent();
        const client = await CodexAppServerClient.start();
        try {
          const models = codexModels(await client.request("model/list", {}));
          const configured = modelForProvider(String(getPref("skimModel")));
          return {
            ok: true,
            version: "Codex App Server (configured)",
            models: models.length ? models : configured ? [configured] : [],
          };
        } finally {
          client.close();
        }
      }
      case "claude-code": {
        requireConsent();
        // Confirms the CLI is installed and runnable. Login is verified on the
        // first real request; --version does not consume plan usage.
        const version = await claudeVersion();
        const configured = modelForProvider(String(getPref("skimModel")));
        return {
          ok: true,
          version: `Claude Code (${version})`,
          models: configured ? [configured] : [],
        };
      }
      default: {
        // OpenAI-compatible /models works for Ollama, vLLM, OpenAI, OpenRouter,
        // etc. Anthropic's compat endpoint also exposes it.
        const response = (await request("GET", "/models", undefined, {
          timeout: 12000,
        })) as { data?: { id?: unknown }[] };
        return {
          ok: true,
          version: "OpenAI-compatible",
          models: (response.data || [])
            .map((model) => model.id)
            .filter((id): id is string => typeof id === "string"),
        };
      }
    }
  } catch (error) {
    return { ok: false, models: [], error: String(error) };
  }
}

/** Selection/chunking token budget (user-configurable via one setting). */
export function contextLimitTokens(): number {
  return Math.max(2048, Number(getPref("contextTokens")) || 8192);
}

// ---------- token usage accounting ----------

export interface TokenUsage {
  input: number;
  output: number;
}

let usageTotal: TokenUsage = { input: 0, output: 0 };

/** Reset the running token counter (call at the start of a run). */
export function resetTokenUsage(): void {
  usageTotal = { input: 0, output: 0 };
}

/** Read the tokens consumed since the last reset. */
export function getTokenUsage(): TokenUsage {
  return { ...usageTotal };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Add a response's usage to the running total, across provider shapes. */
export function recordUsage(input: unknown, output: unknown): void {
  usageTotal.input += num(input);
  usageTotal.output += num(output);
}

/**
 * Structured chat completion. The caller owns prompt/schema validation; this
 * module owns all transport and provider-specific response extraction. Token
 * usage is accumulated into the module counter (getTokenUsage).
 */
export async function chatJSON(opts: {
  model: string;
  system: string;
  user: string;
  schema: object;
  temperature?: number;
}): Promise<unknown> {
  const messages = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  let content: string | null = null;

  switch (apiType()) {
    case "codex-app-server":
      return codexJSON(opts);
    case "claude-code":
      return claudeCodeJSON(opts);
    default: {
      const numCtx = ollamaNumCtx();
      if (numCtx > 0) {
        // Native Ollama endpoint — the only way to set the context window.
        // (The OpenAI-compatible endpoint silently ignores num_ctx.)
        const response = (await request(
          "POST",
          "/api/chat",
          {
            model: opts.model,
            stream: false,
            format: opts.schema,
            keep_alive: "30m",
            // Reasoning buys nothing here (the task is "return these ids as
            // JSON") while costing latency and, on small models, correctness.
            // Ignored by models without a thinking mode, and by older Ollama.
            think: false,
            options: { temperature: opts.temperature ?? 0, num_ctx: numCtx },
            messages,
          },
          { native: true },
        )) as {
          message?: { content?: unknown };
          prompt_eval_count?: unknown;
          eval_count?: unknown;
        };
        recordUsage(response.prompt_eval_count, response.eval_count);
        const value = response.message?.content;
        content = typeof value === "string" ? value : null;
        break;
      }
      // One OpenAI-compatible chat call for every other HTTP endpoint. Some
      // servers ignore response_format but still return valid JSON when
      // instructed; parseLooseJSON tolerates that.
      const response = (await request("POST", "/chat/completions", {
        model: opts.model,
        temperature: opts.temperature ?? 0,
        messages,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "local_reader_output",
            strict: true,
            schema: opts.schema,
          },
        },
      })) as {
        choices?: { message?: { content?: unknown } }[];
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };
      recordUsage(
        response.usage?.prompt_tokens,
        response.usage?.completion_tokens,
      );
      const value = response.choices?.[0]?.message?.content;
      content = typeof value === "string" ? value : null;
    }
  }

  if (!content)
    throw new Error(`${providerLabel()} returned no message content`);
  return parseLooseJSON(content);
}

/** Configured models not present in the server's model list. */
export function missingModels(status: OllamaStatus): string[] {
  // Subprocess providers manage their own models; nothing to check.
  if (isSubprocessProvider() || status.models.length === 0) return [];
  const wanted = [String(getPref("skimModel")), String(getPref("tldrModel"))];
  return [...new Set(wanted)].filter(
    (wantedModel) =>
      wantedModel &&
      !status.models.includes(wantedModel) &&
      !status.models.some((model) => model.startsWith(wantedModel)),
  );
}
