import { spawn } from "node:child_process";
import type { Duplex, Readable, Writable } from "node:stream";

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

export { readNode24TypeDefinitions } from "./node24.ts";

const maximumStderrLength = 64 * 1024;

export class HostNodeRuntime implements Runtime {
  readonly #nodePath: string;

  constructor(options: { readonly nodePath: string }) {
    this.#nodePath = options.nodePath;
  }

  async start(req: StartRequest): Promise<RuntimeInstance> {
    req.signal.throwIfAborted();

    const child = spawn(this.#nodePath, ["--input-type=module"], {
      env: {
        ...process.env,
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

    const channel: ByteChannel = {
      incoming: readableChunks(fd3),
      outgoing: new NodeWritableByteWriter(fd3),
    };

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendTextTail(stderr, chunk);
    });

    let terminationRequested = false;

    const abort = (): void => {
      terminationRequested = true;
      child.kill("SIGTERM");
    };

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
      terminationRequested = true;
      child.kill("SIGTERM");
      await finished;
      throw error;
    }

    return {
      channel,
      finished,
      async terminate(reason: string): Promise<void> {
        void reason;
        terminationRequested = true;
        child.kill("SIGTERM");
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
