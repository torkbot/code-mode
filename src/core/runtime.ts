export interface RuntimeStartRequest {
  readonly payload: RuntimePayload;
  readonly signal: AbortSignal;
}

/** Code-mode support code and the submitted agent program. */
export interface RuntimePayload {
  /**
   * The source is a self-contained ECMAScript module. Evaluating it exports
   * startProgram(channel), which the runtime must invoke exactly once and await
   * as the payload's execution task.
   */
  readonly kind: "javascript-module";
  /**
   * The module has no runtime dependency on this package. Agent-authored
   * dynamic imports still use the execution environment's module resolution.
   */
  readonly source: string;
}

export interface Runtime {
  /**
   * Opaque context an embedder may present to an agent when describing the
   * execution environment. Code mode does not interpret or present it.
   */
  readonly description: string;
  /**
   * Load checker declarations for this execution environment.
   * Implementations must stop promptly when the signal aborts.
   */
  loadTypeDefinitionFiles(
    signal: AbortSignal,
  ): Promise<readonly TypeDefinitionFile[]>;
  /**
   * Launch the supplied payload in this execution environment.
   *
   * The payload receives one endpoint of a bidirectional byte channel through
   * startProgram(channel). The returned instance exposes the other endpoint:
   * bytes written to either endpoint's outgoing writer must arrive, in order,
   * from the peer endpoint's incoming iterable.
   *
   * This promise resolves when the payload has been launched and the returned
   * channel is ready for I/O. Launch failures reject after any partial runtime
   * has been stopped. If the signal aborts after launch, the runtime must stop
   * the execution promptly.
   */
  start(req: RuntimeStartRequest): Promise<RuntimeInstance>;
}

export interface TypeDefinitionFile {
  readonly path: string;
  readonly contents: string;
}

export interface RuntimeInstance {
  /** The host endpoint paired with the channel passed to startProgram(). */
  readonly channel: ByteChannel;
  /**
   * Resolves exactly once after the execution environment can no longer
   * exchange bytes. Runtime failures are values; this promise does not reject.
   */
  readonly finished: Promise<RuntimeFinished>;
  /**
   * Requests execution termination and resolves after finished. Calls are
   * idempotent; reason is diagnostic context for the runtime implementation.
   */
  terminate(reason: string): Promise<void>;
}

export interface ByteChannel {
  readonly incoming: AsyncIterable<Uint8Array>;
  readonly outgoing: ByteWriter;
}

export interface ByteWriter {
  /** Delivers one chunk to the peer endpoint without mutating it. */
  write(chunk: Uint8Array): Promise<void>;
  /**
   * Flushes prior writes and ends the peer endpoint's incoming iterable.
   * Repeated calls are idempotent.
   */
  close(): Promise<void>;
}

export type RuntimeFinished =
  | {
      /** The payload ended normally or termination was requested. */
      readonly kind: "closed";
    }
  | {
      /** The execution environment ended unexpectedly after launch. */
      readonly kind: "failed";
      readonly error: Error;
    };
