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

test("a terminal program error does not wait for a non-cooperative tool call", async () => {
  const toolCall = encodeProgramMessage({
    kind: "tool-call",
    id: "call-1",
    name: "hold",
    input: {},
    stack: "Error: Tool call stack",
  });
  const programError = encodeProgramMessage({
    kind: "program-error",
    error: {
      name: "Error",
      message: "agent failed",
      stack: null,
      details: null,
    },
  });
  let finishRuntime: ((result: RuntimeFinished) => void) | undefined;
  const finished = new Promise<RuntimeFinished>((resolve) => {
    finishRuntime = resolve;
  });
  let markToolStarted: (() => void) | undefined;
  const toolStarted = new Promise<void>((resolve) => {
    markToolStarted = resolve;
  });
  const runtime: Runtime = {
    async start() {
      return {
        channel: {
          incoming: (async function* () {
            yield toolCall;
            await toolStarted;
            yield programError;
          })(),
          outgoing: {
            async write() {
              throw new Error("runtime channel is closed");
            },
            async close() {
              throw new Error("runtime channel is already closed");
            },
          },
        },
        finished,
        async terminate() {
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
          description: "Fail when the program terminates.",
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
        async () => {
          markToolStarted?.();
          return await new Promise<never>(() => {});
        },
      ),
    ]),
    environment: {
      description: "Terminal program-error test environment.",
      typeDefinitionFiles: [],
    },
  });

  const outcome = await client.run("async () => {}").result;

  assert.equal(outcome.kind, "program-failed");
  assert.equal(outcome.error.message, "agent failed");
});

test("execution terminates a runtime after a completed protocol message", async () => {
  let terminateReason: string | undefined;
  let finishRuntime: ((result: RuntimeFinished) => void) | undefined;
  const finished = new Promise<RuntimeFinished>((resolve) => {
    finishRuntime = resolve;
  });
  const runtime: Runtime = {
    async start() {
      return {
        channel: {
          incoming: fromChunks([encodeProgramMessage({ kind: "completed" })]),
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
    toolbox: createToolbox([]),
    environment: {
      description: "Terminal completion test environment.",
      typeDefinitionFiles: [],
    },
  });

  assert.deepEqual(await client.run("async () => {}").result, { kind: "success" });
  assert.equal(terminateReason, "Code-mode program completed");
  assert.deepEqual(await finished, { kind: "closed" });
});

test("tool completion telemetry requires a delivered response", async () => {
  const toolCall = encodeProgramMessage({
    kind: "tool-call",
    id: "call-1",
    name: "complete",
    input: {},
    stack: "Error: Tool call stack",
  });
  const programError = encodeProgramMessage({
    kind: "program-error",
    error: {
      name: "Error",
      message: "channel failed",
      stack: null,
      details: null,
    },
  });
  let markSecondWrite: (() => void) | undefined;
  const secondWrite = new Promise<void>((resolve) => {
    markSecondWrite = resolve;
  });
  let writes = 0;
  let finishRuntime: ((result: RuntimeFinished) => void) | undefined;
  const finished = new Promise<RuntimeFinished>((resolve) => {
    finishRuntime = resolve;
  });
  const runtime: Runtime = {
    async start() {
      return {
        channel: {
          incoming: (async function* () {
            yield toolCall;
            await secondWrite;
            yield programError;
          })(),
          outgoing: {
            async write() {
              writes++;
              if (writes === 2) {
                markSecondWrite?.();
              }
              throw new Error("runtime channel is closed");
            },
            async close() {},
          },
        },
        finished,
        async terminate() {
          finishRuntime?.({ kind: "closed" });
        },
      };
    },
  };
  const client = createClient({
    runtime,
    toolbox: createToolbox([
      defineTool(
        "complete",
        {
          description: "Complete before response delivery fails.",
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
        async () => ({}),
      ),
    ]),
    environment: {
      description: "Tool response telemetry test environment.",
      typeDefinitionFiles: [],
    },
  });
  const toolEvents: string[] = [];

  await client.run("async () => {}", {
    onTelemetry(event) {
      if (event.kind.startsWith("tool-call-")) {
        toolEvents.push(event.kind);
      }
    },
  }).result;

  assert.deepEqual(toolEvents, ["tool-call-started", "tool-call-failed"]);
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
