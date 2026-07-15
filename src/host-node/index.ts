import { execFile, spawn } from "node:child_process";
import { Duplex, Writable } from "node:stream";

import type { RuntimeFinished, RuntimeInstance } from "../core/runtime.ts";
import {
  Node24Runtime,
  type Node24RuntimeHost,
  type Node24RuntimeLaunchRequest,
} from "../node/index.ts";

const maximumStderrLength = 64 * 1024;
const terminationGracePeriodMilliseconds = 1_000;
const nodeVersionsByPath = new Map<string, string>();

export class HostNodeRuntime extends Node24Runtime {
  constructor(nodePath: string) {
    super(new HostNodeRuntimeHost(nodePath));
  }
}

class HostNodeRuntimeHost implements Node24RuntimeHost {
  readonly #nodePath: string;

  constructor(nodePath: string) {
    this.#nodePath = nodePath;
  }

  async readNodeVersion(
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    const cached = nodeVersionsByPath.get(this.#nodePath);
    if (cached !== undefined) {
      return cached;
    }

    const version = await readHostNodeVersion(this.#nodePath, signal);
    nodeVersionsByPath.set(this.#nodePath, version);
    return version;
  }

  async launchNode(req: Node24RuntimeLaunchRequest): Promise<RuntimeInstance> {
    req.signal.throwIfAborted();
    const { NODE_OPTIONS: _nodeOptions, ...environment } = process.env;
    const stdio = Array.from(
      { length: req.channelFileDescriptor + 1 },
      (_value, descriptor): "ignore" | "pipe" => (
        descriptor === 0
        || descriptor === 2
        || descriptor === req.channelFileDescriptor
          ? "pipe"
          : "ignore"
      ),
    );

    const child = spawn(this.#nodePath, ["--input-type=module"], {
      env: environment,
      stdio,
    });

    const channelStream = child.stdio[req.channelFileDescriptor];
    assertChannelStream(channelStream, req.channelFileDescriptor);
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

    const channel = createWebChannel(channelStream);
    const launched = new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        child.off("error", onError);
        child.off("spawn", onSpawn);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onSpawn = (): void => {
        cleanup();
        resolve();
      };

      child.once("error", onError);
      child.once("spawn", onSpawn);
    });

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
      await launched;
      const bootstrapWriter = Writable.toWeb(stdin).getWriter();
      await bootstrapWriter.write(
        Buffer.from(req.bootstrapSource, "utf8"),
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

    if (req.signal.aborted) {
      requestTermination();
      await finished;
      throw req.signal.reason;
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

function readHostNodeVersion(
  nodePath: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      nodePath,
      ["--version"],
      { encoding: "utf8", signal },
      (error, stdout) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
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

function createWebChannel(stream: Duplex): RuntimeInstance["channel"] {
  let settlePendingRead: (() => void) | undefined;
  const readable = new ReadableStream<Uint8Array>({
    pull(controller) {
      return new Promise<void>((resolve) => {
        const cleanup = (): void => {
          stream.off("data", onData);
          stream.off("end", onEnd);
          stream.off("error", onError);
          stream.off("close", onClose);
          settlePendingRead = undefined;
        };
        const settle = (): void => {
          stream.pause();
          cleanup();
          resolve();
        };
        const onData = (chunk: unknown): void => {
          if (chunk instanceof Uint8Array) {
            controller.enqueue(chunk);
          } else {
            controller.error(
              new Error("Host Node.js runtime emitted an unsupported channel chunk"),
            );
          }
          settle();
        };
        const onEnd = (): void => {
          controller.close();
          settle();
        };
        const onError = (error: Error): void => {
          controller.error(error);
          settle();
        };
        const onClose = (): void => {
          controller.close();
          settle();
        };

        settlePendingRead = settle;
        stream.once("data", onData);
        stream.once("end", onEnd);
        stream.once("error", onError);
        stream.once("close", onClose);
        stream.resume();
      });
    },
    cancel() {
      settlePendingRead?.();
    },
  }, { highWaterMark: 0 });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        stream.write(chunk, (error) => {
          if (error === null || error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
    close() {
      if (stream.destroyed || stream.writableEnded) {
        return;
      }
      return new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          stream.off("error", onError);
          stream.off("finish", onFinish);
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const onFinish = (): void => {
          cleanup();
          resolve();
        };

        stream.once("error", onError);
        stream.once("finish", onFinish);
        stream.end();
      });
    },
  });

  return { readable, writable };
}

function assertChannelStream(
  value: unknown,
  descriptor: number,
): asserts value is Duplex {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as Duplex).write !== "function" ||
    typeof (value as Duplex).end !== "function" ||
    typeof (value as Duplex)[Symbol.asyncIterator] !== "function"
  ) {
    throw new Error(`Host Node.js runtime did not create fd ${descriptor}`);
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
