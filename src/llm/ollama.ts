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

type ApiType =
  | "ollama"
  | "openai-compatible"
  | "openai-api"
  | "anthropic"
  | "codex-app-server";

interface RequestOptions {
  headers?: Record<string, string>;
  timeout?: number;
}

function apiType(): ApiType {
  const value = String(getPref("apiType") || "ollama");
  // `openai` was the pre-0.6 name for a localhost-compatible server.
  if (value === "openai" || value === "openai-compatible") {
    return "openai-compatible";
  }
  if (
    value === "openai-api" ||
    value === "anthropic" ||
    value === "codex-app-server"
  ) {
    return value;
  }
  return "ollama";
}

export function providerLabel(): string {
  switch (apiType()) {
    case "openai-compatible":
      return "OpenAI-compatible local server";
    case "openai-api":
      return "OpenAI API";
    case "anthropic":
      return "Anthropic API";
    case "codex-app-server":
      return "Codex App Server";
    default:
      return "Ollama";
  }
}

function isCloudProvider(): boolean {
  return (
    apiType() === "openai-api" ||
    apiType() === "anthropic" ||
    apiType() === "codex-app-server"
  );
}

function baseUrl(): string {
  switch (apiType()) {
    case "openai-api":
      return "https://api.openai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com/v1";
    case "openai-compatible": {
      let url = String(
        getPref("ollamaUrl") || "http://localhost:11434",
      ).replace(/\/+$/, "");
      if (!/\/v1$/.test(url)) url += "/v1";
      return url;
    }
    default:
      return String(getPref("ollamaUrl") || "http://localhost:11434").replace(
        /\/+$/,
        "",
      );
  }
}

function assertLocalhost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(/[/:]/)[0];
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
    throw new Error(
      `Refusing non-local LLM endpoint: ${host}. Use a local server, or choose an explicit cloud provider.`,
    );
  }
}

function cloudHeaders(): Record<string, string> {
  if (!getPref("cloudConsent")) {
    throw new Error(
      "Cloud inference is disabled. Confirm that extracted PDF text may leave this computer in Local Reader settings.",
    );
  }
  if (apiType() === "openai-api") {
    const key = String(getPref("openaiApiKey") || "").trim();
    if (!key)
      throw new Error("Enter an OpenAI API key in Local Reader settings.");
    return { Authorization: `Bearer ${key}` };
  }
  if (apiType() === "codex-app-server") return {};
  const key = String(getPref("anthropicApiKey") || "").trim();
  if (!key)
    throw new Error("Enter an Anthropic API key in Local Reader settings.");
  return {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
  };
}

async function request(
  method: "GET" | "POST",
  path: string,
  body?: object,
  options: RequestOptions = {},
): Promise<unknown> {
  const url = `${baseUrl()}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (isCloudProvider()) Object.assign(headers, cloudHeaders());
  else assertLocalhost(url);

  const xhr = await Zotero.HTTP.request(method, url, {
    headers,
    body: body ? JSON.stringify(body) : undefined,
    timeout: options.timeout ?? 120000,
    responseType: "text",
  });
  return JSON.parse(xhr.response) as unknown;
}

/** A Codex App Server run intentionally has one model for all reader tasks. */
export function modelForProvider(configuredModel: string): string {
  if (apiType() === "codex-app-server") {
    return String(getPref("codexModel") || "").trim();
  }
  return configuredModel.trim();
}

function readOpenAIResponseText(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const obj = response as {
    output_text?: unknown;
    output?: unknown;
  };
  if (typeof obj.output_text === "string") return obj.output_text;
  if (!Array.isArray(obj.output)) return null;
  const parts: string[] = [];
  for (const item of obj.output) {
    const content = (item as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const text = (part as { text?: unknown })?.text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.length ? parts.join("") : null;
}

interface CodexPipe {
  readString(): Promise<string>;
}

interface CodexSubprocess {
  stdin: { write(value: string): void };
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
        `Could not start Codex App Server (${command}). Run codex login and set the Codex CLI path in Local Reader settings. ${String(error)}`,
      );
    }
    const client = new CodexAppServerClient(process);
    await client.request("initialize", {
      clientInfo: { name: "local-reader", version: "0.8.0" },
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
      // Local Reader never grants Codex tools, filesystem access, or Zotero MCP.
      this.write({
        id: message.id,
        error: { code: -32601, message: "Tools are disabled in Local Reader." },
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
  cloudHeaders(); // enforces explicit consent without reading an API key
  const client = await CodexAppServerClient.start();
  try {
    const model = modelForProvider(opts.model);
    if (!model)
      throw new Error("Enter a Codex model in Local Reader settings.");
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
    return JSON.parse(content) as unknown;
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

/** Check the configured provider without ever falling back to another one. */
export async function checkStatus(): Promise<OllamaStatus> {
  try {
    switch (apiType()) {
      case "openai-compatible": {
        const response = (await request("GET", "/models", undefined, {
          timeout: 8000,
        })) as { data?: { id?: unknown }[] };
        return {
          ok: true,
          version: "OpenAI-compatible local server",
          models: (response.data || [])
            .map((model) => model.id)
            .filter((id): id is string => typeof id === "string"),
        };
      }
      case "openai-api": {
        const response = (await request("GET", "/models", undefined, {
          timeout: 15000,
        })) as { data?: { id?: unknown }[] };
        return {
          ok: true,
          version: "OpenAI API",
          models: (response.data || [])
            .map((model) => model.id)
            .filter((id): id is string => typeof id === "string"),
        };
      }
      case "anthropic":
        // Anthropic has no equivalent public model-list endpoint. Do not make a
        // billable test request merely to refresh the reader sidebar.
        cloudHeaders();
        return {
          ok: true,
          version: "Anthropic API (configured)",
          models: modelForProvider(String(getPref("skimModel")))
            ? [modelForProvider(String(getPref("skimModel")))]
            : [],
        };
      case "codex-app-server": {
        cloudHeaders();
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
      default: {
        const [version, tags] = (await Promise.all([
          request("GET", "/api/version", undefined, { timeout: 5000 }),
          request("GET", "/api/tags", undefined, { timeout: 5000 }),
        ])) as [{ version?: unknown }, { models?: { name?: unknown }[] }];
        return {
          ok: true,
          version:
            typeof version.version === "string" ? version.version : undefined,
          models: (tags.models || [])
            .map((model) => model.name)
            .filter((name): name is string => typeof name === "string"),
        };
      }
    }
  } catch (error) {
    return { ok: false, models: [], error: String(error) };
  }
}

/** Maximum total context, conservatively reserving room for instructions/output. */
export function contextLimitTokens(): number {
  if (isCloudProvider()) {
    return Math.max(16000, Number(getPref("cloudContextTokens")) || 120000);
  }
  return Math.max(2048, Number(getPref("numCtx")) || 8192);
}

/**
 * Structured chat completion. The caller owns prompt/schema validation; this
 * module owns all transport and provider-specific response extraction.
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
    case "openai-api": {
      const response = await request("POST", "/responses", {
        model: opts.model,
        // Paper text is sensitive. Do not ask OpenAI to retain this request.
        store: false,
        max_output_tokens: Math.max(
          1024,
          Number(getPref("maxOutputTokens")) || 16384,
        ),
        input: messages,
        text: {
          format: {
            type: "json_schema",
            name: "local_reader_output",
            strict: true,
            schema: opts.schema,
          },
        },
      });
      content = readOpenAIResponseText(response);
      break;
    }
    case "anthropic": {
      const response = (await request("POST", "/messages", {
        model: opts.model,
        max_tokens: Math.max(1024, Number(getPref("maxOutputTokens")) || 16384),
        temperature: opts.temperature ?? 0,
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
        output_config: {
          format: { type: "json_schema", schema: opts.schema },
        },
      })) as { content?: { type?: unknown; text?: unknown }[] };
      const text = response.content?.find((part) => part.type === "text")?.text;
      content = typeof text === "string" ? text : null;
      break;
    }
    case "openai-compatible": {
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
      })) as { choices?: { message?: { content?: unknown } }[] };
      const value = response.choices?.[0]?.message?.content;
      content = typeof value === "string" ? value : null;
      break;
    }
    default: {
      const response = (await request("POST", "/api/chat", {
        model: opts.model,
        stream: false,
        format: opts.schema,
        keep_alive: "30m",
        options: {
          temperature: opts.temperature ?? 0,
          num_ctx: contextLimitTokens(),
        },
        messages,
      })) as { message?: { content?: unknown } };
      const value = response.message?.content;
      content = typeof value === "string" ? value : null;
    }
  }

  if (!content)
    throw new Error(`${providerLabel()} returned no message content`);
  return JSON.parse(content) as unknown;
}

/** Models required by current settings that are missing on the server. */
export function missingModels(status: OllamaStatus): string[] {
  if (isCloudProvider()) return [];
  const wanted = [String(getPref("skimModel")), String(getPref("tldrModel"))];
  return [...new Set(wanted)].filter(
    (wantedModel) =>
      !status.models.includes(wantedModel) &&
      !status.models.some((model) => model.startsWith(wantedModel)),
  );
}
