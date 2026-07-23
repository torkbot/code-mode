/** Full-duplex byte channel used by the code-mode wire protocol. */
export interface RunnerChannel {
  /** Bytes received from the host-side Runtime. */
  readonly readable: ReadableStream<Uint8Array>;
  /** Bytes sent to the host-side Runtime. */
  readonly writable: WritableStream<Uint8Array>;
}

/** Text emitted by the console created for one program execution. */
export interface RunnerProgramOutput {
  /** Logical destination selected by the console method. */
  readonly stream: "stdout" | "stderr";
  /** Platform-formatted output text. */
  readonly text: string;
}

/** Minimum console surface passed beside `codemode` to an agent program. */
export interface RunnerConsole {
  /** Emit diagnostic output, normally on stdout. */
  debug(...values: unknown[]): void;
  /** Emit error output on stderr. */
  error(...values: unknown[]): void;
  /** Emit informational output, normally on stdout. */
  info(...values: unknown[]): void;
  /** Emit ordinary output on stdout. */
  log(...values: unknown[]): void;
  /** Emit warning output on stderr. */
  warn(...values: unknown[]): void;
}

/** Runtime-specific inputs for evaluating one fresh root module. */
export interface RunnerImportRequest {
  /** JavaScript ESM source received in an execution request. */
  readonly source: string;
  /** Logical cancellation signal for this execution. */
  readonly signal: AbortSignal;
}

/** Platform hooks required to attach the reusable runner to an environment. */
export interface RunnerOptions {
  /** Runner endpoint of the full-duplex Runtime connection. */
  readonly channel: RunnerChannel;
  /**
   * Schedule one complete execution, including module evaluation and invocation.
   * Call `execute` exactly once and adopt its result. Drivers can run callbacks
   * immediately for multiplexing or queue them for serial execution.
   */
  schedule(execute: () => Promise<void>): Promise<void>;
  /**
   * Evaluate source as a fresh root ESM module and return its namespace. Static
   * imports use the platform's native module resolution. Implementations may
   * offer stronger cancellation by observing the supplied signal.
   */
  importModule(request: RunnerImportRequest): Promise<Record<string, unknown>>;
  /**
   * Create the scope-only console for one execution. Formatting is deliberately
   * platform-defined; call `emit` with text and its stdout/stderr provenance.
   */
  createConsole(emit: (output: RunnerProgramOutput) => void): RunnerConsole;
}

/**
 * Serve execution requests over one Runtime connection.
 *
 * The runner evaluates every request as a fresh root module, requires a callable
 * default export, invokes it with `{ codemode, console }`, awaits it, and ignores
 * its fulfilled value. Everything referenced by this function is nested so the
 * matching `@torkbot/code-mode/runner/source` export is self-contained.
 *
 * @param options Runtime-specific channel, module loader, and console hooks.
 */
export async function startRunner(options: RunnerOptions): Promise<void> {
  const maximumFrameLength = 16 * 1024 * 1024;
  const frameHeaderLength = 4;
  const maximumErrorNameLength = 256;
  const maximumErrorMessageLength = 64 * 1024;
  const maximumErrorStackLength = 128 * 1024;
  const maximumErrorReportLength = 8 * 1024;
  const executions = new Map<string, ExecutionState>();
  const writer = options.channel.writable.getWriter();
  let writeQueue: Promise<void> = Promise.resolve();

  type SerializedError = {
    readonly name: string;
    readonly message: string;
    readonly stack: string | null;
    readonly details: { readonly kind: "tool-validation"; readonly report: string } | null;
  };
  type Outcome =
    | { readonly kind: "success" }
    | { readonly kind: "program-failed"; readonly error: SerializedError };
  type HostMessage =
    | { readonly kind: "execute"; readonly executionId: string; readonly source: string }
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
        readonly error: SerializedError;
      }
    | {
        readonly kind: "cancel";
        readonly executionId: string;
        readonly error: SerializedError;
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
        readonly outcome: Outcome;
      };
  type ToolResponse = PromiseWithResolvers<unknown>;
  type ExecutionState = {
    readonly cancellation: AbortController;
    readonly toolResponses: Map<string, ToolResponse>;
  };

  const send = (message: RunnerMessage): Promise<void> => {
    let frame: Uint8Array;
    try {
      const serialized = JSON.stringify(message);
      if (serialized === undefined) {
        throw new TypeError("Code-mode wire messages must be JSON-compatible");
      }
      const body = new TextEncoder().encode(serialized);
      if (body.byteLength > maximumFrameLength) {
        throw new Error(
          `Code-mode wire frame length ${body.byteLength} exceeds ${maximumFrameLength}`,
        );
      }
      frame = new Uint8Array(frameHeaderLength + body.byteLength);
      new DataView(frame.buffer).setUint32(0, body.byteLength, true);
      frame.set(body, frameHeaderLength);
    } catch (error) {
      return Promise.reject(error);
    }
    const write = writeQueue.then(async () => {
      await writer.write(frame);
    });
    writeQueue = write.catch(() => {});
    return write;
  };

  try {
    await send({ kind: "ready" });

    for await (const value of readFrames(options.channel.readable)) {
      const message = parseHostMessage(value);

      if (message.kind === "execute") {
        if (executions.has(message.executionId)) {
          throw new Error(`Duplicate code-mode execution id: ${message.executionId}`);
        }
        const state: ExecutionState = {
          cancellation: new AbortController(),
          toolResponses: new Map(),
        };
        executions.set(message.executionId, state);
        void options.schedule(() => executeProgram(message, state)).catch((error: unknown) => {
          executions.delete(message.executionId);
          state.cancellation.abort(error);
          for (const response of state.toolResponses.values()) {
            response.reject(error);
          }
          state.toolResponses.clear();
          void writer.abort(error).catch(() => {});
        });
        continue;
      }

      const state = executions.get(message.executionId);
      if (state === undefined) continue;

      if (message.kind === "cancel") {
        state.cancellation.abort(reviveError(message.error));
        for (const response of state.toolResponses.values()) {
          response.reject(state.cancellation.signal.reason);
        }
        state.toolResponses.clear();
        executions.delete(message.executionId);
        continue;
      }

      const response = state.toolResponses.get(message.toolCallId);
      if (response === undefined) continue;
      state.toolResponses.delete(message.toolCallId);
      if (message.kind === "tool-result") {
        response.resolve(message.result);
      } else {
        response.reject(reviveError(message.error));
      }
    }

    cancelExecutions(new Error("Code-mode runtime connection closed"));
    await writeQueue;
    await writer.close();
  } catch (error) {
    cancelExecutions(error);
    await writer.abort(error).catch(() => {});
    throw error;
  } finally {
    writer.releaseLock();
  }

  function cancelExecutions(reason: unknown): void {
    for (const state of executions.values()) {
      state.cancellation.abort(reason);
      for (const response of state.toolResponses.values()) {
        response.reject(reason);
      }
      state.toolResponses.clear();
    }
    executions.clear();
  }

  async function executeProgram(
    message: Extract<HostMessage, { readonly kind: "execute" }>,
    state: ExecutionState,
  ): Promise<void> {
    if (state.cancellation.signal.aborted) return;
    state.cancellation.signal.throwIfAborted();
    let nextToolCallId = 0;
    const emit = (output: RunnerProgramOutput): void => {
      if (state.cancellation.signal.aborted) return;
      void send({
        kind: "program-output",
        executionId: message.executionId,
        stream: output.stream,
        text: output.text,
      }).catch(() => {});
    };
    const programConsole = options.createConsole(emit);
    const codemode = new Proxy(Object.create(null) as Record<string, unknown>, {
      get(_target, property) {
        if (typeof property !== "string" || property === "then") return undefined;
        return (input: unknown): Promise<unknown> => {
          try {
            state.cancellation.signal.throwIfAborted();
            assertJsonValue(input);
          } catch (error) {
            return Promise.reject(error);
          }
          const toolCallId = String(nextToolCallId++);
          const response = Promise.withResolvers<unknown>();
          state.toolResponses.set(toolCallId, response);
          const call = send({
            kind: "tool-call",
            executionId: message.executionId,
            toolCallId,
            name: property,
            input,
          }).then(() => response.promise);
          void call.catch(() => {});
          return call;
        };
      },
    });

    let outcome: Outcome;
    try {
      const module = await options.importModule({
        source: message.source,
        signal: state.cancellation.signal,
      });
      state.cancellation.signal.throwIfAborted();
      const program = module["default"];
      if (typeof program !== "function") {
        throw new TypeError(
          "Code-mode program must default-export a function",
        );
      }
      await Reflect.apply(program, undefined, [{ codemode, console: programConsole }]);
      outcome = { kind: "success" };
    } catch (error) {
      outcome = {
        kind: "program-failed",
        error: serializeError(error),
      };
    }

    if (state.cancellation.signal.aborted) return;
    executions.delete(message.executionId);
    const completed = new Error("Code-mode program execution completed");
    state.cancellation.abort(completed);
    for (const response of state.toolResponses.values()) response.reject(completed);
    state.toolResponses.clear();
    await send({
      kind: "execution-result",
      executionId: message.executionId,
      outcome,
    });
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

        const copied = Math.min(
          body.byteLength - bodyLength,
          chunk.byteLength - offset,
        );
        body.set(chunk.subarray(offset, offset + copied), bodyLength);
        bodyLength += copied;
        offset += copied;
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

  function parseHostMessage(value: unknown): HostMessage {
    if (!isRecord(value)) throwInvalidHostMessage();

    switch (value["kind"]) {
      case "execute":
        if (
          typeof value["executionId"] === "string"
          && typeof value["source"] === "string"
        ) {
          return value as unknown as Extract<HostMessage, { readonly kind: "execute" }>;
        }
        break;
      case "tool-result":
        if (
          typeof value["executionId"] === "string"
          && typeof value["toolCallId"] === "string"
          && Object.hasOwn(value, "result")
        ) {
          return value as unknown as Extract<HostMessage, { readonly kind: "tool-result" }>;
        }
        break;
      case "tool-error":
        if (
          typeof value["executionId"] === "string"
          && typeof value["toolCallId"] === "string"
          && isSerializedError(value["error"])
        ) {
          return value as unknown as Extract<HostMessage, { readonly kind: "tool-error" }>;
        }
        break;
      case "cancel":
        if (
          typeof value["executionId"] === "string"
          && isSerializedError(value["error"])
        ) {
          return value as unknown as Extract<HostMessage, { readonly kind: "cancel" }>;
        }
        break;
    }

    throwInvalidHostMessage();
  }

  function isSerializedError(value: unknown): value is SerializedError {
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

  function throwInvalidHostMessage(): never {
    throw new Error("Invalid code-mode host message");
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

  function serializeError(error: unknown): SerializedError {
    if (isError(error)) {
      const stack = readNullableErrorString(error, "stack");
      return {
        name: truncateErrorField(
          readErrorString(error, "name", "Error"),
          maximumErrorNameLength,
        ),
        message: truncateErrorField(
          readErrorString(
            error,
            "message",
            "Code-mode error message could not be read",
          ),
          maximumErrorMessageLength,
        ),
        stack: stack === null
          ? null
          : truncateErrorField(stack, maximumErrorStackLength),
        details: readErrorDetails(error),
      };
    }
    return {
      name: "Error",
      message: truncateErrorField(
        stringifyUnknown(error),
        maximumErrorMessageLength,
      ),
      stack: null,
      details: null,
    };
  }

  function reviveError(value: SerializedError): Error {
    const error = new Error(value.message);
    error.name = value.name;
    if (value.stack !== null) error.stack = value.stack;
    if (value.details !== null) Reflect.set(error, "details", value.details);
    return error;
  }

  function readErrorDetails(
    error: Error,
  ): SerializedError["details"] {
    try {
      const details: unknown = Reflect.get(error, "details");
      if (
        isRecord(details)
        && details["kind"] === "tool-validation"
        && typeof details["report"] === "string"
      ) {
        return {
          kind: "tool-validation",
          report: truncateErrorField(
            details["report"],
            maximumErrorReportLength,
          ),
        };
      }
    } catch {}
    return null;
  }

  function readErrorString(
    error: Error,
    property: "name" | "message",
    fallback: string,
  ): string {
    try {
      const value: unknown = Reflect.get(error, property);
      return typeof value === "string" ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function readNullableErrorString(
    error: Error,
    property: "stack",
  ): string | null {
    try {
      const value: unknown = Reflect.get(error, property);
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }

  function stringifyUnknown(value: unknown): string {
    try {
      return String(value);
    } catch {
      return "Code-mode thrown value could not be serialized";
    }
  }

  function truncateErrorField(value: string, maximumLength: number): string {
    if (value.length <= maximumLength) return value;
    const suffix = "... <truncated>";
    return `${value.slice(0, maximumLength - suffix.length)}${suffix}`;
  }

  function isError(value: unknown): value is Error {
    try {
      return value instanceof Error;
    } catch {
      return false;
    }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
