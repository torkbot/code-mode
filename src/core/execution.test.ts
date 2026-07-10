import assert from "node:assert/strict";
import test from "node:test";

import { BSON } from "bson";

import { createClient } from "./client.ts";
import { encodeProgramMessage } from "./protocol/codec.ts";
import type { Runtime, RuntimeFinished } from "./runtime.ts";
import { createToolbox, defineTool } from "./types.ts";
import { testSchema } from "../testing/schema.ts";

test("execution terminates a live runtime when protocol processing fails", async () => {
  const malformedMessage = encodeRawBsonFrame({
    kind: "tool-call",
    id: "call-1",
    input: {},
    stack: "Error: Tool call stack",
  });
  const validToolCall = encodeProgramMessage({
    kind: "tool-call",
    id: "call-before-failure",
    name: "hold",
    input: {},
    stack: "Error: Tool call stack",
  });
  let terminateReason: string | undefined;
  let toolSignal: AbortSignal | undefined;
  let toolStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    toolStarted = resolve;
  });
  let toolStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    toolStopped = resolve;
  });
  let finishRuntime: ((result: RuntimeFinished) => void) | undefined;
  const finished = new Promise<RuntimeFinished>((resolve) => {
    finishRuntime = resolve;
  });
  const runtime: Runtime = {
    async start() {
      return {
        channel: {
          incoming: fromChunks([validToolCall, malformedMessage]),
          outgoing: {
            async write() {},
            async close() {},
          },
        },
        finished,
        async terminate(reason) {
          terminateReason = reason;
          finishRuntime?.({ kind: "closed" });
        },
      };
    },
  };
  const client = createClient({
    runtime,
    toolbox: createToolbox([
      defineTool(
        "hold",
        {
          description: "Hold until the runtime protocol fails.",
          inputSchema: testSchema({
            type: "object",
            properties: {},
            additionalProperties: false,
          }),
          outputSchema: testSchema({
            type: "object",
            properties: {},
            additionalProperties: false,
          }),
        },
        async (ctx) => {
          toolSignal = ctx.signal;
          toolStarted?.();
          if (!ctx.signal.aborted) {
            await new Promise<void>((resolve) => {
              ctx.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
          toolStopped?.();
          return {};
        },
      ),
    ]),
    environment: {
      description: "Protocol failure test environment.",
      typeDefinitionFiles: [],
    },
  });

  const result = client.run("async () => {}").result;
  await assert.rejects(
    result,
    /Invalid code-mode program message/,
  );
  await started;
  await stopped;
  assert.equal(terminateReason, "Code-mode execution failed");
  assert.equal(toolSignal?.aborted, true);
  assert.deepEqual(await finished, { kind: "closed" });
});

function encodeRawBsonFrame(document: Record<string, unknown>): Uint8Array {
  const frame = BSON.serialize(document);
  const packet = new Uint8Array(4 + frame.byteLength);
  new DataView(packet.buffer, packet.byteOffset, 4).setUint32(0, frame.byteLength, true);
  packet.set(frame, 4);
  return packet;
}

async function* fromChunks(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}
