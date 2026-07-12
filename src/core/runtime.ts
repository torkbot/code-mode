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
  start(req: StartRequest): Promise<RuntimeInstance>;
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
