export interface StartRequest {
  readonly program: Program;
  readonly signal: AbortSignal;
}

export type Program = JavaScriptModuleProgram;

export interface JavaScriptModuleProgram {
  readonly kind: "javascript-module";
  /**
   * Self-contained ESM source that exports startProgram(channel).
   */
  readonly source: string;
}

export const programEntrypointName = "startProgram";

export interface RuntimeProgramModule {
  /**
   * Runs the generated code-mode program over the byte channel supplied by the runtime adapter.
   */
  startProgram(channel: ByteChannel): Promise<void>;
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
