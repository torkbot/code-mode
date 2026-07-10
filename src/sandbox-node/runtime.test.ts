import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import type { Duplex } from "node:stream";
import test from "node:test";

import { testRuntime } from "../testing/index.ts";
import {
  SandboxNodeRuntime,
  type SandboxNodeHost,
  type SandboxNodeProcess,
  type SandboxNodeSpawnOptions,
} from "./index.ts";

testRuntime({
  name: "sandbox-node runtime",
  async createRuntime() {
    return new SandboxNodeRuntime({
      sandbox: new HostBackedSandbox(),
      nodePath: process.execPath,
      cwd: process.cwd(),
    });
  },
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
      kind: "javascript-module",
      source: "export async function startProgram() {}",
    },
    signal: controller.signal,
  });

  assert.equal(killed, true);
  assert.deepEqual(await instance.finished, { kind: "closed" });
});

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
