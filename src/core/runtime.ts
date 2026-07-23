import { settleBeforeAbort } from "./abort.ts";
import { errorFromUnknown, type TelemetryError } from "./telemetry.ts";
import { runnerSource } from "../runner/source.ts";

/** A virtual file mounted into the client's TypeScript checking project. */
export interface TypeDefinitionFile {
  /** Normalized project-relative path, such as `node_modules/pkg/index.d.ts`. */
  readonly path: string;
  /** Complete UTF-8 text of the virtual file. */
  readonly contents: string;
}

/** One text chunk written by the console passed to an agent program. */
export interface RuntimeProgramOutput {
  /** Logical destination selected by the console method. */
  readonly stream: "stdout" | "stderr";
  /** Runtime-formatted text. It may contain part of a line or several lines. */
  readonly text: string;
}

/** A tool invocation requested by a program running inside a Runtime. */
export interface RuntimeToolCall {
  /** Property name read from the program's `codemode` object. */
  readonly name: string;
  /** Tool input received over the runtime connection. */
  readonly input: unknown;
  /** Aborts when the execution is cancelled or no longer needs this call. */
  readonly signal: AbortSignal;
}

/** Inputs supplied for one program execution on a connected Runtime. */
export interface RuntimeExecuteRequest {
  /**
   * ECMAScript module source whose default export must be callable. Erasable
   * TypeScript must already have been stripped without shifting source lines.
   */
  readonly source: string;
  /** Cancels this execution without governing the Runtime's lifetime. */
  readonly signal: AbortSignal;
  /** Handle one program tool call and return its JSON-compatible result. */
  invokeTool(request: RuntimeToolCall): Promise<unknown>;
  /** Receive runtime-formatted output from the console passed to the program. */
  emitOutput(output: RuntimeProgramOutput): void;
}

/** Observable completion of an agent program. Transport failures reject execute(). */
export type RunOutcome =
  | {
      /** The default export fulfilled; its value was ignored. */
      readonly kind: "success";
    }
  | {
      /** Module evaluation or the default export failed. */
      readonly kind: "program-failed";
      /** Serializable failure reported by the runner. */
      readonly error: TelemetryError;
    };

/** A booted runtime that can execute independent programs over one connection. */
export interface Runtime extends AsyncDisposable {
  /** Opaque environment description an embedder may present to an agent. */
  readonly description: string;
  /** Resolves once this Runtime can no longer execute programs. Never rejects. */
  readonly finished: Promise<RuntimeFinished>;
  /** Load checker-only declarations for modules and globals available at runtime. */
  loadTypeDefinitionFiles(
    signal: AbortSignal,
  ): Promise<readonly TypeDefinitionFile[]>;
  /** Execute one fresh root ESM module; runtimes may schedule calls concurrently. */
  execute(request: RuntimeExecuteRequest): Promise<RunOutcome>;
  /** Close the connection and release the driver-owned runtime resources. */
  [Symbol.asyncDispose](): Promise<void>;
}

/** Terminal state of a Runtime or RuntimeConnection. */
export type RuntimeFinished =
  | {
      /** The resource closed normally or in response to disposal. */
      readonly kind: "closed";
    }
  | {
      /** The resource stopped unexpectedly. */
      readonly kind: "failed";
      /** Driver or protocol failure that ended the resource. */
      readonly error: Error;
    };

/**
 * Driver-owned byte connection to a booted runner. The core runtime owns the
 * wire protocol on this channel; execution request identifiers stay internal.
 */
export interface RuntimeConnection extends AsyncDisposable {
  /** Host endpoint of the full-duplex byte channel connected to the runner. */
  readonly channel: {
    /** Bytes emitted by the runner. */
    readonly readable: ReadableStream<Uint8Array>;
    /** Bytes sent to the runner. */
    readonly writable: WritableStream<Uint8Array>;
  };
  /** Resolves once the underlying runtime can no longer exchange bytes. */
  readonly finished: Promise<RuntimeFinished>;
  /** Stop the underlying runtime and resolve after `finished`. */
  [Symbol.asyncDispose](): Promise<void>;
}

/** Standard boot inputs supplied by createRuntimeFactory() to a driver. */
export interface RuntimeDriverConnectRequest {
  /** Self-contained ESM source exporting `startRunner()`. */
  readonly runnerSource: string;
  /** Governs connection and runner readiness only, not its later lifetime. */
  readonly signal: AbortSignal;
}

/**
 * Runtime-specific boot adapter. Drivers decide placement, scheduling strength,
 * and how the supplied runner source reaches their execution environment.
 */
export interface RuntimeDriver<Options> {
  /** Opaque environment description copied onto each connected Runtime. */
  readonly description: string;
  /** Load checker-only declarations for the driver's execution environment. */
  loadTypeDefinitionFiles(
    signal: AbortSignal,
  ): Promise<readonly TypeDefinitionFile[]>;
  /** Boot and connect one runner using the caller's required driver options. */
  connect(
    options: Options,
    request: RuntimeDriverConnectRequest,
  ): Promise<RuntimeConnection>;
}

/** Factory that boots one connected Runtime from required driver options. */
export type RuntimeFactory<Options> = (
  /** Options defined by the selected RuntimeDriver. */
  options: Options,
  /** Governs boot through runner readiness, then detaches. */
  signal: AbortSignal,
) => Promise<Runtime>;

/**
 * Build a user-facing Runtime factory around a low-level driver. The factory
 * supplies the version-matched runner, completes its readiness handshake, and
 * cleans up partial connections when boot fails.
 *
 * @param driver Runtime-specific connection and type-declaration adapter.
 * @returns A factory that creates ready Runtime instances for that driver.
 */
export function createRuntimeFactory<Options>(
  driver: RuntimeDriver<Options>,
): RuntimeFactory<Options> {
  return async (options, signal) => {
    signal.throwIfAborted();
    const connection = await driver.connect(options, {
      runnerSource,
      signal,
    });
    const runtime = new ConnectedRuntime(driver, connection);

    try {
      await settleBeforeAbort(runtime.ready, signal);
      return runtime;
    } catch (error) {
      await runtime[Symbol.asyncDispose]().catch(() => {});
      throw error;
    }
  };
}

const maximumFrameLength = 16 * 1024 * 1024;
const frameHeaderLength = 4;

type HostMessage =
  | {
      readonly kind: "execute";
      readonly executionId: string;
      readonly source: string;
    }
  | {
      readonly kind: "tool-result";
      readonly executionId: string;
      readonly toolCallId: string;
      readonly result: unknown;
    }
  | {
      readonly kind: "tool-error";
      readonly executionId: string;
      readonly toolCallId: string;
      readonly error: TelemetryError;
    }
  | {
      readonly kind: "cancel";
      readonly executionId: string;
      readonly error: TelemetryError;
    };

type RunnerMessage =
  | { readonly kind: "ready" }
  | {
      readonly kind: "tool-call";
      readonly executionId: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly kind: "program-output";
      readonly executionId: string;
      readonly stream: "stdout" | "stderr";
      readonly text: string;
    }
  | {
      readonly kind: "execution-result";
      readonly executionId: string;
      readonly outcome: RunOutcome;
    };

interface ExecutionState {
  readonly request: RuntimeExecuteRequest;
  readonly result: PromiseWithResolvers<RunOutcome>;
  readonly toolCancellation: AbortController;
  readonly toolSignal: AbortSignal;
  abort(): void;
}

class ConnectedRuntime implements Runtime {
  readonly description: string;
  readonly finished: Promise<RuntimeFinished>;
  readonly ready: Promise<void>;

  readonly #driver: RuntimeDriver<unknown>;
  readonly #connection: RuntimeConnection;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #finishedResult = Promise.withResolvers<RuntimeFinished>();
  readonly #readyResult = Promise.withResolvers<void>();
  readonly #executions = new Map<string, ExecutionState>();
  #writeQueue: Promise<void> = Promise.resolve();
  #nextExecutionId = 0;
  #ready = false;
  #disposed = false;
  #finished = false;
  #disposal: Promise<void> | undefined;

  constructor(driver: RuntimeDriver<unknown>, connection: RuntimeConnection) {
    this.description = driver.description;
    this.#driver = driver;
    this.#connection = connection;
    this.#writer = connection.channel.writable.getWriter();
    this.finished = this.#finishedResult.promise;
    this.ready = this.#readyResult.promise;

    void this.#readMessages();
    void connection.finished.then(
      (result) => this.#finish(result),
      (error: unknown) => this.#finish({
        kind: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      }),
    );
  }

  loadTypeDefinitionFiles(
    signal: AbortSignal,
  ): Promise<readonly TypeDefinitionFile[]> {
    return this.#driver.loadTypeDefinitionFiles(signal);
  }

  async execute(request: RuntimeExecuteRequest): Promise<RunOutcome> {
    request.signal.throwIfAborted();
    if (this.#disposed) {
      throw new Error("Code-mode runtime is closed");
    }
    if (!this.#ready) {
      throw new Error("Code-mode runtime runner is not ready");
    }

    const executionId = String(this.#nextExecutionId++);
    const result = Promise.withResolvers<RunOutcome>();
    const toolCancellation = new AbortController();
    const toolSignal = AbortSignal.any([
      request.signal,
      toolCancellation.signal,
    ]);
    const abort = (): void => {
      request.signal.removeEventListener("abort", abort);
      const state = this.#executions.get(executionId);
      if (state === undefined) return;
      this.#executions.delete(executionId);
      state.toolCancellation.abort(request.signal.reason);
      state.result.reject(request.signal.reason);
      void this.#send({
        kind: "cancel",
        executionId,
        error: errorFromUnknown(request.signal.reason),
      }).catch(() => {});
    };
    const state: ExecutionState = {
      request,
      result,
      toolCancellation,
      toolSignal,
      abort,
    };
    this.#executions.set(executionId, state);
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) {
      abort();
      return await result.promise;
    }

    try {
      const [, outcome] = await Promise.all([
        this.#send({
          kind: "execute",
          executionId,
          source: request.source,
        }),
        result.promise,
      ]);
      return outcome;
    } catch (error) {
      if (this.#executions.delete(executionId)) {
        request.signal.removeEventListener("abort", abort);
        toolCancellation.abort(error);
      }
      throw error;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#disposal ??= this.#dispose();
    await this.#disposal;
  }

  async #dispose(): Promise<void> {
    this.#disposed = true;

    const closeChannel = (async (): Promise<void> => {
      try {
        await this.#writeQueue;
        await this.#writer.close();
      } catch {
        // Disposing the connection may close the channel first.
      } finally {
        this.#writer.releaseLock();
      }
    })();
    await Promise.all([
      closeChannel,
      this.#connection[Symbol.asyncDispose](),
    ]);
    this.#finish(await this.#connection.finished);
    await this.finished;
  }

  async #readMessages(): Promise<void> {
    try {
      for await (const value of readFrames(this.#connection.channel.readable)) {
        const message = parseRunnerMessage(value);
        if (message.kind === "ready") {
          if (this.#ready) {
            throw new Error("Code-mode runner sent ready more than once");
          }
          this.#ready = true;
          this.#readyResult.resolve();
          continue;
        }
        if (!this.#ready) {
          throw new Error("Code-mode runner sent an execution message before ready");
        }
        this.#handleMessage(message);
      }
      if (!this.#disposed) {
        throw new Error("Code-mode runner channel closed unexpectedly");
      }
    } catch (error) {
      if (this.#disposed) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#finish({ kind: "failed", error: failure });
      void this[Symbol.asyncDispose]().catch(() => {});
    }
  }

  #handleMessage(message: Exclude<RunnerMessage, { readonly kind: "ready" }>): void {
    const state = this.#executions.get(message.executionId);
    if (state === undefined) return;

    if (message.kind === "program-output") {
      try {
        state.request.emitOutput({
          stream: message.stream,
          text: message.text,
        });
      } catch {
        // Program output is observational and cannot change execution semantics.
      }
      return;
    }

    if (message.kind === "tool-call") {
      void this.#invokeTool(message, state).catch(() => {});
      return;
    }

    this.#executions.delete(message.executionId);
    state.request.signal.removeEventListener("abort", state.abort);
    state.toolCancellation.abort(
      new Error("Code-mode program execution completed"),
    );
    state.result.resolve(message.outcome);
  }

  async #invokeTool(
    message: Extract<RunnerMessage, { readonly kind: "tool-call" }>,
    state: ExecutionState,
  ): Promise<void> {
    try {
      state.toolSignal.throwIfAborted();
      const result = await state.request.invokeTool({
        name: message.name,
        input: message.input,
        signal: state.toolSignal,
      });
      state.toolSignal.throwIfAborted();
      assertJsonValue(result);
      await this.#send({
        kind: "tool-result",
        executionId: message.executionId,
        toolCallId: message.toolCallId,
        result,
      });
    } catch (error) {
      if (state.toolSignal.aborted) return;
      await this.#send({
        kind: "tool-error",
        executionId: message.executionId,
        toolCallId: message.toolCallId,
        error: errorFromUnknown(error),
      });
    }
  }

  #send(message: HostMessage): Promise<void> {
    let frame: Uint8Array;
    try {
      frame = encodeFrame(message);
    } catch (error) {
      return Promise.reject(error);
    }
    const write = this.#writeQueue.then(async () => {
      await this.#writer.write(frame);
    });
    void write.catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#finish({ kind: "failed", error: failure });
      void this[Symbol.asyncDispose]().catch(() => {});
    });
    this.#writeQueue = write.catch(() => {});
    return write;
  }

  #finish(result: RuntimeFinished): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#disposed = true;
    const error = result.kind === "failed"
      ? result.error
      : new Error("Code-mode runtime connection closed");
    if (!this.#ready) this.#readyResult.reject(error);
    for (const state of this.#executions.values()) {
      state.request.signal.removeEventListener("abort", state.abort);
      state.toolCancellation.abort(error);
      state.result.reject(error);
    }
    this.#executions.clear();
    this.#finishedResult.resolve(result);
  }
}

function encodeFrame(value: unknown): Uint8Array {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Code-mode wire messages must be JSON-compatible");
  }
  const body = new TextEncoder().encode(serialized);
  if (body.byteLength > maximumFrameLength) {
    throw new Error(
      `Code-mode wire frame length ${body.byteLength} exceeds ${maximumFrameLength}`,
    );
  }
  const frame = new Uint8Array(frameHeaderLength + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength, true);
  frame.set(body, frameHeaderLength);
  return frame;
}

async function* readFrames(
  readable: ReadableStream<Uint8Array>,
): AsyncIterable<unknown> {
  const header = new Uint8Array(frameHeaderLength);
  let headerLength = 0;
  let body: Uint8Array | undefined;
  let bodyLength = 0;

  for await (const chunk of readable) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (body === undefined) {
        const copied = Math.min(
          frameHeaderLength - headerLength,
          chunk.byteLength - offset,
        );
        header.set(chunk.subarray(offset, offset + copied), headerLength);
        headerLength += copied;
        offset += copied;
        if (headerLength < frameHeaderLength) continue;

        const length = new DataView(header.buffer).getUint32(0, true);
        if (length > maximumFrameLength) {
          throw new Error(
            `Code-mode wire frame length ${length} exceeds ${maximumFrameLength}`,
          );
        }
        body = new Uint8Array(length);
      }

      const length = Math.min(
        body.byteLength - bodyLength,
        chunk.byteLength - offset,
      );
      body.set(chunk.subarray(offset, offset + length), bodyLength);
      bodyLength += length;
      offset += length;
      if (bodyLength !== body.byteLength) continue;

      yield JSON.parse(new TextDecoder().decode(body));
      headerLength = 0;
      body = undefined;
      bodyLength = 0;
    }
  }

  if (headerLength !== 0 || body !== undefined) {
    throw new Error("Code-mode wire stream ended with a truncated frame");
  }
}

function parseRunnerMessage(value: unknown): RunnerMessage {
  if (!isRecord(value)) throwInvalidRunnerMessage();

  switch (value["kind"]) {
    case "ready":
      return value as unknown as Extract<RunnerMessage, { readonly kind: "ready" }>;
    case "tool-call":
      if (
        typeof value["executionId"] === "string"
        && typeof value["toolCallId"] === "string"
        && typeof value["name"] === "string"
        && Object.hasOwn(value, "input")
      ) {
        return value as unknown as Extract<RunnerMessage, { readonly kind: "tool-call" }>;
      }
      break;
    case "program-output":
      if (
        typeof value["executionId"] === "string"
        && (value["stream"] === "stdout" || value["stream"] === "stderr")
        && typeof value["text"] === "string"
      ) {
        return value as unknown as Extract<RunnerMessage, { readonly kind: "program-output" }>;
      }
      break;
    case "execution-result":
      if (
        typeof value["executionId"] === "string"
        && isRunOutcome(value["outcome"])
      ) {
        return value as unknown as Extract<RunnerMessage, { readonly kind: "execution-result" }>;
      }
      break;
  }

  throwInvalidRunnerMessage();
}

function isRunOutcome(value: unknown): value is RunOutcome {
  if (!isRecord(value)) return false;
  return value["kind"] === "success"
    || (value["kind"] === "program-failed" && isTelemetryError(value["error"]));
}

function isTelemetryError(value: unknown): value is TelemetryError {
  if (
    !isRecord(value)
    || typeof value["name"] !== "string"
    || typeof value["message"] !== "string"
    || (value["stack"] !== null && typeof value["stack"] !== "string")
  ) {
    return false;
  }

  const details = value["details"];
  return details === null
    || (
      isRecord(details)
      && details["kind"] === "tool-validation"
      && typeof details["report"] === "string"
    );
}

function throwInvalidRunnerMessage(): never {
  throw new Error("Invalid code-mode runner message");
}

function assertJsonValue(value: unknown, ancestors = new Set<object>()): void {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new TypeError("Code-mode tool values must be JSON-compatible");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (
        keys.length !== value.length
        || keys.some((key, index) => key !== String(index))
      ) {
        throw new TypeError("Code-mode tool values must be JSON-compatible");
      }
      for (const item of value) assertJsonValue(item, ancestors);
      return;
    }

    if (
      Object.prototype.toString.call(value) !== "[object Object]"
      || typeof Reflect.get(value, "toJSON") === "function"
    ) {
      throw new TypeError("Code-mode tool values must be JSON-compatible");
    }
    for (const item of Object.values(value)) assertJsonValue(item, ancestors);
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      if (Object.getOwnPropertyDescriptor(value, symbol)?.enumerable === true) {
        throw new TypeError("Code-mode tool values must be JSON-compatible");
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
