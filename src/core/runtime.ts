export interface StartRequest {
  readonly program: Program;
  readonly signal: AbortSignal;
}

export interface Program {
  /**
   * Self-contained ESM source that exports startProgram(channel).
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
  start(req: StartRequest): Promise<RuntimeInstance>;
}

export interface TypeDefinitionFile {
  readonly path: string;
  readonly contents: string;
}

export interface RuntimeInstance {
  readonly channel: ByteChannel;
  readonly finished: Promise<RuntimeFinished>;
  terminate(reason: string): Promise<void>;
}

export interface ByteChannel {
  readonly incoming: AsyncIterable<Uint8Array>;
  readonly outgoing: ByteWriter;
}

export interface ByteWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export type RuntimeFinished =
  | {
      readonly kind: "closed";
    }
  | {
      readonly kind: "failed";
      readonly error: Error;
    };
