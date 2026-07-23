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

function encodeFrame(value: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(4 + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength, true);
  frame.set(body, 4);
  return frame;
}
