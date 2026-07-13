import { spawn } from "node:child_process";
import type { Duplex, Readable, Writable } from "node:stream";

import type {
  ByteChannel,
  ByteWriter,
  Runtime,
  RuntimeFinished,
  RuntimeInstance,
  StartRequest,
  TypeDefinitionFile,
} from "../core/runtime.ts";
import {
  createNodeBootstrapSource,
  nodeChannelFd,
  nodeChannelFdEnvironmentVariable,
} from "../node-runtime/bootstrap.ts";
import { loadNode24TypeDefinitionFiles } from "../node-runtime/node24.ts";

const maximumStderrLength = 64 * 1024;
const terminationGracePeriodMilliseconds = 1_000;

export class HostNodeRuntime implements Runtime {
  readonly description = "Node.js 24";
  readonly #nodePath: string;

  constructor(nodePath: string) {
    this.#nodePath = nodePath;
  }

  loadTypeDefinitionFiles(): Promise<readonly TypeDefinitionFile[]> {
    return loadNode24TypeDefinitionFiles();
  }

  async start(req: StartRequest): Promise<RuntimeInstance> {
    req.signal.throwIfAborted();
    const { NODE_OPTIONS: _nodeOptions, ...environment } = process.env;

    const child = spawn(this.#nodePath, ["--input-type=module"], {
      env: {
        ...environment,
        [nodeChannelFdEnvironmentVariable]: String(nodeChannelFd),
      },
      stdio: ["pipe", "ignore", "pipe", "pipe"],
    });

    const fd3 = child.stdio[3];
    assertChannelStream(fd3);
    const stdin = child.stdin;
    if (stdin === null) {
      child.kill("SIGTERM");
      throw new Error("Host Node.js runtime did not create stdin");
    }
    const stderrStream = child.stderr;
    if (stderrStream === null) {
      child.kill("SIGTERM");
      throw new Error("Host Node.js runtime did not create stderr");
    }

    const channel: ByteChannel = {
      incoming: readableChunks(fd3),
      outgoing: new NodeWritableByteWriter(fd3),
    };

    let stderr = "";
    stderrStream.setEncoding("utf8");
    stderrStream.on("data", (chunk: string) => {
      stderr = appendTextTail(stderr, chunk);
    });

    let terminationRequested = false;
    let forceTerminationTimeout: ReturnType<typeof setTimeout> | undefined;

    const requestTermination = (): void => {
      terminationRequested = true;
      child.kill("SIGTERM");
      forceTerminationTimeout ??= setTimeout(() => {
        child.kill("SIGKILL");
      }, terminationGracePeriodMilliseconds);
      forceTerminationTimeout.unref();
    };
    const abort = (): void => requestTermination();

    if (req.signal.aborted) {
      abort();
    } else {
      req.signal.addEventListener("abort", abort, { once: true });
    }

    const finished = new Promise<RuntimeFinished>((resolve) => {
      let settled = false;

      const settle = (result: RuntimeFinished): void => {
        if (settled) {
          return;
        }

        settled = true;
        req.signal.removeEventListener("abort", abort);
        if (forceTerminationTimeout !== undefined) {
          clearTimeout(forceTerminationTimeout);
        }
        resolve(result);
      };

      child.once("error", (error) => {
        settle({
          kind: "failed",
          error,
        });
      });

      child.once("close", (code, signal) => {
        if (terminationRequested) {
          settle({ kind: "closed" });
          return;
        }

        if (code === 0 && signal === null) {
          settle({ kind: "closed" });
          return;
        }

        settle({
          kind: "failed",
          error: new Error(formatChildFailure(code, signal, stderr)),
        });
      });
    });

    try {
      const bootstrapWriter = new NodeWritableByteWriter(stdin);
      await bootstrapWriter.write(
        Buffer.from(createNodeBootstrapSource(req.program), "utf8"),
      );
      await bootstrapWriter.close();
    } catch (error) {
      requestTermination();
      await finished;
      if (req.signal.aborted) {
        throw req.signal.reason;
      }
      throw error;
    }

    return {
      channel,
      finished,
      async terminate(reason: string): Promise<void> {
        void reason;
        requestTermination();
        await finished;
      },
    };
  }
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

async function* readableChunks(readable: Readable): AsyncIterable<Uint8Array> {
  for await (const chunk of readable) {
    if (chunk instanceof Uint8Array) {
      yield chunk;
      continue;
    }

    if (typeof chunk === "string") {
      yield Buffer.from(chunk);
      continue;
    }

    throw new Error("Host Node.js runtime emitted an unsupported channel chunk");
  }
}

function assertChannelStream(value: unknown): asserts value is Duplex {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as Writable).write !== "function" ||
    typeof (value as Writable).end !== "function" ||
    typeof (value as Readable)[Symbol.asyncIterator] !== "function"
  ) {
    throw new Error("Host Node.js runtime did not create fd 3");
  }
}

function formatChildFailure(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  const status = `Host Node.js runtime failed with exit code ${code}, signal ${signal}`;
  const detail = stderr.trim();

  if (detail.length === 0) {
    return status;
  }

  return `${status}: ${detail}`;
}

class NodeWritableByteWriter implements ByteWriter {
  readonly #writable: Writable;
  #writeError: Error | undefined;

  constructor(writable: Writable) {
    this.#writable = writable;
    this.#writable.on("error", (error: Error) => {
      this.#writeError ??= error;
    });
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.#writeError !== undefined) {
      throw this.#writeError;
    }
    if (this.#writable.destroyed || this.#writable.writableEnded) {
      throw new Error("Host Node.js runtime channel is closed");
    }

    await new Promise<void>((resolve, reject) => {
      const onClose = (): void => {
        cleanup();
        reject(
          this.#writeError
          ?? new Error("Host Node.js runtime channel closed during a write"),
        );
      };
      const onWrite = (error?: Error | null): void => {
        cleanup();
        if (error === null || error === undefined) {
          resolve();
          return;
        }
        reject(error);
      };
      const cleanup = (): void => {
        this.#writable.off("close", onClose);
      };

      this.#writable.once("close", onClose);
      this.#writable.write(chunk, onWrite);
    });
  }

  async close(): Promise<void> {
    if (this.#writable.destroyed || this.#writable.writableEnded) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onFinish = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        this.#writable.off("error", onError);
        this.#writable.off("finish", onFinish);
      };

      this.#writable.once("error", onError);
      this.#writable.once("finish", onFinish);
      this.#writable.end();
    });
  }
}
