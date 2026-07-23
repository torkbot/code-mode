import assert from "node:assert/strict";
import test from "node:test";

import { startRunner } from "./index.ts";

test("runner rejects malformed host messages at its byte boundary", async () => {
  const hostToRunner = new TransformStream<Uint8Array, Uint8Array>();
  const runnerToHost = new TransformStream<Uint8Array, Uint8Array>();
  const runner = startRunner({
    channel: {
      readable: hostToRunner.readable,
      writable: runnerToHost.writable,
    },
    schedule: (execute) => execute(),
    async importModule() {
      throw new Error("malformed messages must not be evaluated");
    },
    createConsole() {
      throw new Error("malformed messages must not create a console");
    },
  });
  const rejected = assert.rejects(runner, /Invalid code-mode host message/);

  const outputReader = runnerToHost.readable.getReader();
  const ready = await outputReader.read();
  assert.equal(ready.done, false);

  const inputWriter = hostToRunner.writable.getWriter();
  await inputWriter.write(encodeFrame({
    kind: "cancel",
    executionId: 42,
    error: null,
  })).catch(() => {});
  await inputWriter.close().catch(() => {});

  await rejected;
  await outputReader.cancel().catch(() => {});
});

test("runner settles executions that call tools after cancellation", async () => {
  const hostToRunner = new TransformStream<Uint8Array, Uint8Array>();
  const runnerToHost = new TransformStream<Uint8Array, Uint8Array>();
  const scheduled = Promise.withResolvers<{ readonly execution: Promise<void> }>();
  const runner = startRunner({
    channel: {
      readable: hostToRunner.readable,
      writable: runnerToHost.writable,
    },
    schedule(execute) {
      const execution = execute();
      scheduled.resolve({ execution });
      return execution;
    },
    async importModule() {
      return {
        default: async (scope: {
          readonly codemode: Record<string, (input: unknown) => Promise<unknown>>;
        }) => {
          try {
            await scope.codemode["wait"]?.({});
          } catch {}
          await scope.codemode["afterCancel"]?.({});
        },
      };
    },
    createConsole() {
      return {
        debug() {},
        error() {},
        info() {},
        log() {},
        warn() {},
      };
    },
  });
  const outputReader = runnerToHost.readable.getReader();
  const inputWriter = hostToRunner.writable.getWriter();

  assert.deepEqual(await readFrame(outputReader), { kind: "ready" });
  await inputWriter.write(encodeFrame({
    kind: "execute",
    executionId: "execution",
    source: "unused",
  }));
  assert.deepEqual(await readFrame(outputReader), {
    kind: "tool-call",
    executionId: "execution",
    toolCallId: "0",
    name: "wait",
    input: {},
  });
  await inputWriter.write(encodeFrame({
    kind: "cancel",
    executionId: "execution",
    error: {
      name: "Error",
      message: "cancelled",
      stack: null,
      details: null,
    },
  }));

  const { execution } = await scheduled.promise;
  const settled = await Promise.race([
    execution.then(() => true, () => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);

  await outputReader.cancel().catch(() => {});
  await inputWriter.close().catch(() => {});
  await runner.catch(() => {});
  assert.equal(settled, true);
});

async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<unknown> {
  const result = await reader.read();
  assert.equal(result.done, false);
  const frame = result.value;
  assert.ok(frame !== undefined);
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    .getUint32(0, true);
  assert.equal(length, frame.byteLength - 4);
  return JSON.parse(new TextDecoder().decode(frame.subarray(4)));
}

function encodeFrame(value: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(4 + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength, true);
  frame.set(body, 4);
  return frame;
}
