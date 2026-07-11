import type {
  ByteChannel,
  ByteWriter,
  Runtime,
  RuntimeFinished,
  RuntimeInstance,
  StartRequest,
} from "../core/runtime.ts";
import {
  createNodeBootstrapSource,
  nodeChannelFd,
  nodeChannelFdEnvironmentVariable,
} from "../node-runtime/bootstrap.ts";

const maximumStderrLength = 64 * 1024;
const terminationGracePeriodMilliseconds = 1_000;

export interface SandboxNodeRuntimeOptions {
  readonly sandbox: SandboxNodeHost;
  readonly nodePath: string;
  readonly cwd: string;
}

export interface SandboxNodeHost {
  spawn(
    command: string,
    args: readonly string[],
    options: SandboxNodeSpawnOptions,
  ): SandboxNodeProcess;
}

export interface SandboxNodeSpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly pipes: readonly number[];
}

export interface SandboxNodeProcess {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly pipes: ReadonlyMap<number, SandboxNodeProcessPipe>;
  readonly ready: Promise<void>;
  readonly exit: Promise<SandboxNodeProcessExit>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface SandboxNodeProcessPipe {
  readonly input: WritableStream<Uint8Array>;
  readonly output: ReadableStream<Uint8Array>;
}

export interface SandboxNodeProcessExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export class SandboxNodeRuntime implements Runtime {
  readonly #sandbox: SandboxNodeHost;
  readonly #nodePath: string;
  readonly #cwd: string;

  constructor(options: SandboxNodeRuntimeOptions) {
    this.#sandbox = options.sandbox;
    this.#nodePath = options.nodePath;
    this.#cwd = options.cwd;
  }

  async start(req: StartRequest): Promise<RuntimeInstance> {
    req.signal.throwIfAborted();

    const process = this.#sandbox.spawn(this.#nodePath, ["--input-type=module"], {
      cwd: this.#cwd,
      env: {
        [nodeChannelFdEnvironmentVariable]: String(nodeChannelFd),
      },
      pipes: [nodeChannelFd],
    });
    const pipe = process.pipes.get(nodeChannelFd);
    if (pipe === undefined) {
      process.kill("SIGTERM");
      throw new Error(`Sandbox Node runtime did not create fd ${nodeChannelFd}`);
    }

    let terminationRequested = false;
    let forceTerminationTimeout: ReturnType<typeof setTimeout> | undefined;
    const requestTermination = (): void => {
      terminationRequested = true;
      process.kill("SIGTERM");
      forceTerminationTimeout ??= setTimeout(() => {
        process.kill("SIGKILL");
      }, terminationGracePeriodMilliseconds);
    };
    const abort = (): void => requestTermination();
    if (req.signal.aborted) {
      abort();
    } else {
      req.signal.addEventListener("abort", abort, { once: true });
    }

    const stdout = drain(process.stdout);
    const stderr = readText(process.stderr);

    try {
      await writeAndClose(
        process.stdin,
        new TextEncoder().encode(createNodeBootstrapSource(req.program)),
      );
    } catch (error) {
      req.signal.removeEventListener("abort", abort);
      requestTermination();
      await Promise.allSettled([process.exit, stdout, stderr]);
      if (forceTerminationTimeout !== undefined) {
        clearTimeout(forceTerminationTimeout);
      }
      throw error;
    }

    const channel: ByteChannel = {
      incoming: readableChunks(pipe.output),
      outgoing: new WebByteWriter(pipe.input),
    };

    const finished: Promise<RuntimeFinished> = (async () => {
      try {
        const [launchError, exit, , stderrText] = await Promise.all([
          process.ready.then(
            () => null,
            (error: unknown) => errorFromUnknown(error),
          ),
          process.exit,
          stdout,
          stderr,
        ]);

        if (terminationRequested) {
          return { kind: "closed" };
        }
        if (launchError !== null) {
          return { kind: "failed", error: launchError };
        }
        if (exit.exitCode === 0 && exit.signal === null) {
          return { kind: "closed" };
        }
        return {
          kind: "failed",
          error: new Error(formatProcessFailure(exit, stderrText)),
        };
      } catch (error) {
        return {
          kind: "failed",
          error: errorFromUnknown(error),
        };
      } finally {
        req.signal.removeEventListener("abort", abort);
        if (forceTerminationTimeout !== undefined) {
          clearTimeout(forceTerminationTimeout);
        }
      }
    })();

    return {
      channel,
      finished,
      async terminate(_reason: string): Promise<void> {
        requestTermination();
        await finished;
      },
    };
  }
}

async function writeAndClose(
  stream: WritableStream<Uint8Array>,
  contents: Uint8Array,
): Promise<void> {
  const writer = stream.getWriter();
  try {
    await writer.write(contents);
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}

async function* readableChunks(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        return;
      }
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  for await (const _chunk of readableChunks(stream)) {
    // Drain process output so guest writes cannot block.
  }
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let result = "";
  for await (const chunk of readableChunks(stream)) {
    result = appendTextTail(result, decoder.decode(chunk, { stream: true }));
  }
  return appendTextTail(result, decoder.decode());
}

function appendTextTail(current: string, chunk: string): string {
  if (chunk.length >= maximumStderrLength) {
    return chunk.slice(-maximumStderrLength);
  }

  const overflow = current.length + chunk.length - maximumStderrLength;
  return overflow > 0
    ? `${current.slice(overflow)}${chunk}`
    : `${current}${chunk}`;
}

function formatProcessFailure(
  exit: SandboxNodeProcessExit,
  stderr: string,
): string {
  const status = `Sandbox Node runtime failed with exit code ${exit.exitCode}, signal ${exit.signal}`;
  const detail = stderr.trim();
  return detail.length === 0 ? status : `${status}: ${detail}`;
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

class WebByteWriter implements ByteWriter {
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  #closed = false;

  constructor(stream: WritableStream<Uint8Array>) {
    this.#writer = stream.getWriter();
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.#closed) {
      throw new Error("Sandbox Node runtime channel is closed");
    }
    await this.#writer.write(chunk);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      await this.#writer.close();
    } finally {
      this.#writer.releaseLock();
    }
  }
}
