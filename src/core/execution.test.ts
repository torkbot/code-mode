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
  });
  const validToolCall = encodeProgramMessage({
    kind: "tool-call",
    id: "call-before-failure",
    name: "hold",
    input: {},
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
    ...testRuntimeMetadata,
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
  });

  const result = client.run("async () => {}", { signal: AbortSignal.timeout(5_000) });
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
    ...testRuntimeMetadata,
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
  });

  const outcome = await client.run("async () => {}", {
    signal: AbortSignal.timeout(5_000),
  });

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
    ...testRuntimeMetadata,
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
  });

  assert.deepEqual(await client.run("async () => {}", {
    signal: AbortSignal.timeout(5_000),
  }), { kind: "success" });
  assert.equal(terminateReason, "Code-mode program completed");
  assert.deepEqual(await finished, { kind: "closed" });
});

test("failed tool response writes reject without completion telemetry", async () => {
  const toolCall = encodeProgramMessage({
    kind: "tool-call",
    id: "call-1",
    name: "complete",
    input: {},
  });
  let finishRuntime: ((result: RuntimeFinished) => void) | undefined;
  const finished = new Promise<RuntimeFinished>((resolve) => {
    finishRuntime = resolve;
  });
  const runtime: Runtime = {
    ...testRuntimeMetadata,
    async start() {
      return {
        channel: {
          incoming: (async function* () {
            yield toolCall;
            await new Promise<never>(() => {});
          })(),
          outgoing: {
            async write() {
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
  });
  const toolEvents: string[] = [];

  await assert.rejects(
    client.run("async () => {}", {
      signal: AbortSignal.timeout(5_000),
      onTelemetry(event) {
        if (event.kind.startsWith("tool-call-")) {
          toolEvents.push(event.kind);
        }
      },
    }),
    /runtime channel is closed/,
  );

  assert.deepEqual(toolEvents, ["tool-call-started", "tool-call-failed"]);
});

test("execution rejects completion while a tool call is pending", async () => {
  const toolCall = encodeProgramMessage({
    kind: "tool-call",
    id: "call-1",
    name: "missing",
    input: {},
  });
  const completed = encodeProgramMessage({ kind: "completed" });
  let finishRuntime: ((result: RuntimeFinished) => void) | undefined;
  const finished = new Promise<RuntimeFinished>((resolve) => {
    finishRuntime = resolve;
  });
  const runtime: Runtime = {
    ...testRuntimeMetadata,
    async start() {
      return {
        channel: {
          incoming: fromChunks([toolCall, completed]),
          outgoing: {
            async write() {
              return await new Promise<never>(() => {});
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
    toolbox: createToolbox([]),
  });

  await assert.rejects(
    client.run("async () => {}", { signal: AbortSignal.timeout(5_000) }),
    /completed while tool calls were still running/,
  );
});

test("execution honors cancellation that occurs while the runtime starts", async () => {
  const controller = new AbortController();
  let terminated = false;
  const runtime: Runtime = {
    ...testRuntimeMetadata,
    async start() {
      controller.abort(new Error("cancel during runtime start"));
      return {
        channel: {
          incoming: fromChunks([]),
          outgoing: {
            async write() {},
            async close() {},
          },
        },
        finished: Promise.resolve({ kind: "closed" }),
        async terminate() {
          terminated = true;
        },
      };
    },
  };
  const client = createClient({
    runtime,
    toolbox: createToolbox([]),
  });

  await assert.rejects(
    client.run("async () => {}", { signal: controller.signal }),
    /cancel during runtime start/,
  );
  assert.equal(terminated, true);
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

const testRuntimeMetadata = {
  description: "Test JavaScript runtime",
  async loadTypeDefinitionFiles() {
    return [];
  },
} as const;
