import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import type { Duplex } from "node:stream";
import test from "node:test";

import { testRuntime } from "../testing/index.ts";
import { createClient, createToolbox } from "../index.ts";
import {
  SandboxNodeRuntime,
  type SandboxNodeHost,
  type SandboxNodeProcess,
  type SandboxNodeSpawnOptions,
} from "./index.ts";

testRuntime({
  name: "sandbox-node runtime",
  async createRuntime() {
    return createSandboxNodeRuntime();
  },
});

test("sandbox-node supplies its Node 24 checking environment", async () => {
  const runtime = createSandboxNodeRuntime();
  const typeDefinitions = await runtime.loadTypeDefinitionFiles();

  assert.equal(runtime.description, "Node.js 24");
  assert.equal(
    typeDefinitions.some((file) => file.path === "node_modules/@types/node/index.d.ts"),
    true,
  );
});

test("sandbox-node observes a signal aborted during spawn", async () => {
  const controller = new AbortController();
  let killed = false;
  const emptyReadable = (): ReadableStream<Uint8Array> => new ReadableStream({
    start(streamController) {
      streamController.close();
    },
  });
  const writable = (): WritableStream<Uint8Array> => new WritableStream();
  const sandbox: SandboxNodeHost = {
    spawn() {
      controller.abort(new Error("cancel during spawn"));
      return {
        stdin: writable(),
        stdout: emptyReadable(),
        stderr: emptyReadable(),
        pipes: new Map([[3, {
          input: writable(),
          output: emptyReadable(),
        }]]),
        ready: Promise.resolve(),
        exit: Promise.resolve({ exitCode: null, signal: "SIGTERM" }),
        kill() {
          killed = true;
        },
      };
    },
  };
  const runtime = new SandboxNodeRuntime({
    sandbox,
    nodePath: process.execPath,
    cwd: process.cwd(),
  });

  const instance = await runtime.start({
    program: {
      source: "export async function startProgram() {}",
    },
    signal: controller.signal,
  });

  assert.equal(killed, true);
  assert.deepEqual(await instance.finished, { kind: "closed" });
});

test("sandbox-node preserves cancellation during bootstrap writes", async () => {
  const controller = new AbortController();
  const reason = new Error("bootstrap cancelled");
  const emptyReadable = new ReadableStream<Uint8Array>({
    start(streamController) {
      streamController.close();
    },
  });
  const sandbox: SandboxNodeHost = {
    spawn() {
      return {
        stdin: new WritableStream({
          write() {
            controller.abort(reason);
            throw new Error("EPIPE");
          },
        }),
        stdout: emptyReadable,
        stderr: new ReadableStream({
          start(streamController) {
            streamController.close();
          },
        }),
        pipes: new Map([[3, {
          input: new WritableStream(),
          output: new ReadableStream(),
        }]]),
        ready: Promise.resolve(),
        exit: Promise.resolve({ exitCode: null, signal: "SIGTERM" }),
        kill() {},
      };
    },
  };
  const runtime = new SandboxNodeRuntime({
    sandbox,
    nodePath: process.execPath,
    cwd: process.cwd(),
  });

  await assert.rejects(runtime.start({
    program: { source: "export async function startProgram() {}" },
    signal: controller.signal,
  }), (error) => error === reason);
});

test("sandbox-node bounds stderr retained for process failures", async () => {
  const runtime = new SandboxNodeRuntime({
    sandbox: new HostBackedSandbox(),
    nodePath: process.execPath,
    cwd: process.cwd(),
  });
  const instance = await runtime.start({
    program: {
      source: `export async function startProgram(channel) {
        await channel.outgoing.close();
        process.stderr.write("x".repeat(100_000) + "stderr sentinel");
        process.exitCode = 7;
      }`,
    },
    signal: AbortSignal.timeout(10_000),
  });

  for await (const _chunk of instance.channel.incoming) {
    // Drain the child channel until the program exits.
  }

  const finished = await instance.finished;
  assert.equal(finished.kind, "failed");
  assert.match(finished.error.message, /stderr sentinel/);
  assert.ok(finished.error.message.length < 66_000);
});

test("sandbox-node resolves package imports from the runtime working directory", async () => {
  const client = createClient({
    runtime: createSandboxNodeRuntime(),
    toolbox: createToolbox([]),
  });

  assert.deepEqual(
    await client.run(`async () => {
      const bson = await import("bson");
      if (typeof bson.BSON.serialize !== "function") throw new Error("missing bson");
    }`, { signal: AbortSignal.timeout(5_000) }),
    { kind: "success" },
  );
});

test("sandbox-node escalates termination when a program ignores SIGTERM", async () => {
  const client = createClient({
    runtime: createSandboxNodeRuntime(),
    toolbox: createToolbox([]),
  });

  assert.deepEqual(
    await client.run(`async () => {
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1_000);
    }`, { signal: AbortSignal.timeout(5_000) }),
    { kind: "success" },
  );
});

function createSandboxNodeRuntime(): SandboxNodeRuntime {
  return new SandboxNodeRuntime({
    sandbox: new HostBackedSandbox(),
    nodePath: process.execPath,
    cwd: process.cwd(),
  });
}

class HostBackedSandbox implements SandboxNodeHost {
  spawn(
    command: string,
    args: readonly string[],
    options: SandboxNodeSpawnOptions,
  ): SandboxNodeProcess {
    const maxFd = Math.max(2, ...options.pipes);
    const stdio: Array<"ignore" | "pipe"> = Array.from(
      { length: maxFd + 1 },
      () => "ignore",
    );
    stdio[0] = "pipe";
    stdio[1] = "pipe";
    stdio[2] = "pipe";
    for (const fd of options.pipes) {
      stdio[fd] = "pipe";
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      stdio,
    });
    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdin === null || stdout === null || stderr === null) {
      throw new Error("Host-backed sandbox did not create stdio");
    }

    const pipes = new Map<number, {
      readonly input: WritableStream<Uint8Array>;
      readonly output: ReadableStream<Uint8Array>;
    }>();
    for (const fd of options.pipes) {
      const stream = child.stdio[fd];
      if (stream === null || !isDuplex(stream)) {
        throw new Error(`Host-backed sandbox did not create fd ${fd}`);
      }
      pipes.set(fd, {
        input: Writable.toWeb(stream) as WritableStream<Uint8Array>,
        output: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
      });
    }

    return {
      stdin: Writable.toWeb(stdin) as WritableStream<Uint8Array>,
      stdout: Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(stderr) as ReadableStream<Uint8Array>,
      pipes,
      ready: once(child, "spawn").then(() => undefined),
      exit: once(child, "close").then(([exitCode, signal]) => ({
        exitCode: exitCode as number | null,
        signal: signal as string | null,
      })),
      kill(signal) {
        child.kill(signal);
      },
    };
  }
}

function isDuplex(value: unknown): value is Duplex {
  return value instanceof Readable
    && typeof (value as unknown as Writable).write === "function";
}
