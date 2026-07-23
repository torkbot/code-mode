import { execFile, spawn } from "node:child_process";
import { Duplex, Writable } from "node:stream";

import type {
  RuntimeConnection,
  RuntimeDriver,
  RuntimeFinished,
} from "../core/runtime.ts";
import { createRuntimeFactory } from "../core/runtime.ts";
import {
  assertNode24Version,
  createNode24BootstrapSource,
  loadNode24TypeDefinitionFiles,
} from "../node-runtime/index.ts";

/** Options for booting the built-in persistent Node.js runtime. */
export interface HostNodeRuntimeOptions {
  /** Absolute or command-resolvable path to the Node.js 24 executable. */
  readonly nodePath: string;
  /** Working directory used to resolve agent-authored module imports. */
  readonly cwd: string;
}

const channelFileDescriptor = 3;
const maximumStderrLength = 64 * 1024;
const terminationGracePeriodMilliseconds = 1_000;
const nodeVersionsByPath = new Map<string, string>();

const hostNodeRuntimeDriver: RuntimeDriver<HostNodeRuntimeOptions> = {
  description: "Node.js 24",
  loadTypeDefinitionFiles: loadNode24TypeDefinitionFiles,
  async connect(options, request) {
    request.signal.throwIfAborted();
    await assertHostNode24(options.nodePath, request.signal);
    request.signal.throwIfAborted();
    return launchHostNode(options, request.runnerSource, request.signal);
  },
};

/**
 * Boot one persistent, multiplexed Node.js runtime. The boot signal is detached
 * after the returned runtime is ready; dispose the runtime to stop its process.
 *
 * @param options Required Node executable and module-resolution directory.
 * @param signal Governs process boot and runner readiness, then detaches.
 */
export const createHostNodeRuntime = createRuntimeFactory(hostNodeRuntimeDriver);

async function launchHostNode(
  options: HostNodeRuntimeOptions,
  runnerSource: string,
  signal: AbortSignal,
): Promise<RuntimeConnection> {
  const { NODE_OPTIONS: _nodeOptions, ...environment } = process.env;
  const child = spawn(options.nodePath, ["--input-type=module"], {
    cwd: options.cwd,
    env: environment,
    stdio: ["pipe", "ignore", "pipe", "pipe"],
  });
  const stdin = child.stdin;
  const stderrStream = child.stderr;
  const channelStream = child.stdio[channelFileDescriptor];
  if (stdin === null || stderrStream === null) {
    child.kill("SIGTERM");
    throw new Error("Host Node.js runtime did not create its bootstrap streams");
  }
  assertChannelStream(channelStream);

  let stderr = "";
  stderrStream.setEncoding("utf8");
  stderrStream.on("data", (chunk: string) => {
    stderr = appendTextTail(stderr, chunk);
  });

  let disposalRequested = false;
  let forceTerminationTimeout: ReturnType<typeof setTimeout> | undefined;
  const requestTermination = (): void => {
    disposalRequested = true;
    child.kill("SIGTERM");
    forceTerminationTimeout ??= setTimeout(() => {
      child.kill("SIGKILL");
    }, terminationGracePeriodMilliseconds);
    forceTerminationTimeout.unref();
  };

  const finished = new Promise<RuntimeFinished>((resolve) => {
    let settled = false;
    const settle = (result: RuntimeFinished): void => {
      if (settled) return;
      settled = true;
      if (forceTerminationTimeout !== undefined) {
        clearTimeout(forceTerminationTimeout);
      }
      resolve(result);
    };
    child.once("error", (error) => settle({ kind: "failed", error }));
    child.once("close", (code, childSignal) => {
      if (disposalRequested || (code === 0 && childSignal === null)) {
        settle({ kind: "closed" });
        return;
      }
      settle({
        kind: "failed",
        error: new Error(formatChildFailure(code, childSignal, stderr)),
      });
    });
  });

  const abort = (): void => requestTermination();
  signal.addEventListener("abort", abort, { once: true });

  try {
    await waitForSpawn(child, signal);
    const writer = Writable.toWeb(stdin).getWriter();
    await writer.write(Buffer.from(createNode24BootstrapSource({
      runnerSource,
      channelFileDescriptor,
    }), "utf8"));
    await writer.close();
    signal.throwIfAborted();
  } catch (error) {
    requestTermination();
    await finished;
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }

  const channel = Duplex.toWeb(channelStream);
  let disposed = false;
  return {
    channel,
    finished,
    async [Symbol.asyncDispose]() {
      if (!disposed) {
        disposed = true;
        requestTermination();
      }
      await finished;
    },
  };
}

async function assertHostNode24(
  nodePath: string,
  signal: AbortSignal,
): Promise<void> {
  const cached = nodeVersionsByPath.get(nodePath);
  if (cached !== undefined) {
    assertNode24Version(cached, "Host Node runtime");
    return;
  }
  const version = await readHostNodeVersion(nodePath, signal);
  assertNode24Version(version, "Host Node runtime");
  nodeVersionsByPath.set(nodePath, version);
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
        } else if (error !== null) {
          reject(error);
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}

function waitForSpawn(
  child: ReturnType<typeof spawn>,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      child.off("error", onError);
      child.off("spawn", onSpawn);
      signal.removeEventListener("abort", onAbort);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onSpawn = (): void => {
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
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

function formatChildFailure(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  const status = `Host Node.js runtime failed with exit code ${code}, signal ${signal}`;
  const detail = stderr.trim();
  return detail.length === 0 ? status : `${status}: ${detail}`;
}

function assertChannelStream(value: unknown): asserts value is Duplex {
  if (
    value === null
    || typeof value !== "object"
    || typeof (value as Duplex).write !== "function"
    || typeof (value as Duplex).end !== "function"
    || typeof (value as Duplex)[Symbol.asyncIterator] !== "function"
  ) {
    throw new Error(
      `Host Node.js runtime did not create fd ${channelFileDescriptor}`,
    );
  }
}
