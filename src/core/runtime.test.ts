import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AgentSourceSyntaxError,
  createProgram,
} from "./program.ts";
import { maximumBsonFrameLength, readProgramMessages } from "./protocol/codec.ts";
import type {
  Runtime,
  RuntimeFinished,
  RuntimeInstance,
  RuntimePayload,
} from "./runtime.ts";
import { maximumTelemetryErrorMessageLength } from "./telemetry.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("a supplied runtime receives a generated JavaScript module payload and exposes its channel peer", async () => {
  let observedPayload: RuntimePayload | undefined;
  const observedWrites: Uint8Array[] = [];
  let outgoingClosed = false;
  let terminationReason: string | undefined;

  const channel: RuntimeInstance["channel"] = {
    readable: singleChunk(encoder.encode("from-runtime")),
    writable: new WritableStream({
      async write(chunk) {
        observedWrites.push(chunk);
      },
      async close() {
        outgoingClosed = true;
      },
    }),
  };

  const finished: RuntimeFinished = { kind: "closed" };
  const runtime: Runtime = {
    description: "Test JavaScript runtime",
    async loadTypeDefinitionFiles() {
      return [];
    },
    async start(req) {
      observedPayload = req.payload;

      const instance: RuntimeInstance = {
        channel,
        finished: Promise.resolve(finished),
        async terminate(reason) {
          terminationReason = reason;
        },
      };

      return instance;
    },
  };

  const controller = new AbortController();
  const instance = await runtime.start({
    payload: createProgram("async () => ({ value: 42 })"),
    signal: controller.signal,
  });

  assert.equal(observedPayload?.kind, "javascript-module");
  assert.match(
    observedPayload?.source ?? "",
    /export async function startProgram\(channel\)/,
  );
  assert.doesNotMatch(observedPayload?.source ?? "", /globalThis\.__/);
  assert.doesNotMatch(observedPayload?.source ?? "", /from "flatted"/);
  assert.doesNotMatch(observedPayload?.source ?? "", /from 'flatted'/);
  assert.doesNotMatch(observedPayload?.source ?? "", /const run = \(\(/);
  assert.match(observedPayload?.source ?? "", /Bundled from flatted/);
  assert.match(observedPayload?.source ?? "", /flattedStringify/);
  assert.match(
    observedPayload?.source ?? "",
    /function __createCodeModeAgentProgram\(console, globalThis, global, Promise\)/,
  );
  assert.match(observedPayload?.source ?? "", /readBsonFrames\(channel\.readable\)/);
  assert.match(observedPayload?.source ?? "", /channel\.writable\.getWriter/);
  assert.match(observedPayload?.source ?? "", /kind: "program-log"/);
  assert.match(observedPayload?.source ?? "", /codemode: new Proxy/);
  assert.match(observedPayload?.source ?? "", /async \(\) => \(\{ value: 42 \}\)/);
  assert.match(observedPayload?.source ?? "", /await run\(scope\)/);

  const chunks: Uint8Array[] = [];
  for await (const chunk of instance.channel.readable) {
    chunks.push(chunk);
  }

  assert.equal(decoder.decode(Buffer.concat(chunks)), "from-runtime");

  const writer = instance.channel.writable.getWriter();
  await writer.write(encoder.encode("to-runtime"));
  await writer.close();
  await instance.terminate("test complete");

  assert.equal(decoder.decode(Buffer.concat(observedWrites)), "to-runtime");
  assert.equal(outgoingClosed, true);
  assert.equal(terminationReason, "test complete");
  assert.deepEqual(await instance.finished, finished);
});

test("createProgram returns a self-contained module", () => {
  const program = createProgram("async () => ({ message: 'hello from code-mode' })");

  assert.equal(program.kind, "javascript-module");
  assert.match(program.source, /export async function startProgram\(channel\)/);
  assert.doesNotMatch(program.source, /globalThis\.__/);
  assert.doesNotMatch(program.source, /from "flatted"/);
  assert.doesNotMatch(program.source, /from 'flatted'/);
  assert.doesNotMatch(program.source, /const run = \(\(/);
  assert.match(program.source, /Bundled from flatted/);
  assert.match(program.source, /flattedStringify/);
  assert.match(program.source, /function __createCodeModeAgentProgram\(console, globalThis, global, Promise\)/);
  assert.match(program.source, /readBsonFrames\(channel\.readable\)/);
  assert.match(program.source, /channel\.writable\.getWriter/);
  assert.match(program.source, /kind: "program-log"/);
  assert.match(program.source, /codemode: new Proxy/);
  assert.match(program.source, /async \(\) => \(\{ message: 'hello from code-mode' \}\)/);
  assert.match(program.source, /await run\(scope\)/);
});

test("createProgram checks syntax in the generated factory context", () => {
  assert.throws(
    () => createProgram('await import("node:fs")'),
    AgentSourceSyntaxError,
  );
});

test("createProgram accepts closing parentheses in regular expressions", () => {
  assert.doesNotThrow(() => createProgram("async () => /\\)/.test(')')"));
  assert.doesNotThrow(() => createProgram("async () => !/\\)/.test(')')"));
  assert.doesNotThrow(() => createProgram("async () => true ? /\\)/ : /x/"));
});

test("generated programs reject oversized host frames before reading a payload", async () => {
  const program = createProgram("async ({ codemode }) => { await codemode.wait({}); }");
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(program.source).toString("base64")}`;
  const runtimeProgram = await import(moduleUrl) as {
    startProgram(channel: RuntimeInstance["channel"]): Promise<void>;
  };
  const writes: Uint8Array[] = [];
  let outgoingClosed = false;

  await runtimeProgram.startProgram({
    readable: singleChunk(encodeFrameLength(maximumBsonFrameLength + 1)),
    writable: new WritableStream({
      async write(chunk) {
        writes.push(chunk);
      },
      async close() {
        outgoingClosed = true;
      },
    }),
  });

  const messages = [];
  for await (const message of readProgramMessages(manyChunks(writes))) {
    messages.push(message);
  }
  assert.deepEqual(messages.map((message) => message.kind), [
    "tool-call",
    "program-error",
  ]);
  const failure = messages[1];
  assert.equal(failure?.kind, "program-error");
  assert.match(failure.error.message, /exceeds the maximum/);
  assert.equal(outgoingClosed, true);
});

test("generated programs bound oversized errors into a program outcome", async () => {
  const program = createProgram(
    `async () => { throw new Error("x".repeat(${maximumBsonFrameLength + 1})); }`,
  );
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(program.source).toString("base64")}`;
  const runtimeProgram = await import(moduleUrl) as {
    startProgram(channel: RuntimeInstance["channel"]): Promise<void>;
  };
  const writes: Uint8Array[] = [];

  await runtimeProgram.startProgram({
    readable: manyChunks([]),
    writable: new WritableStream({
      async write(chunk) {
        writes.push(chunk);
      },
      async close() {},
    }),
  });

  const messages = [];
  for await (const message of readProgramMessages(manyChunks(writes))) {
    messages.push(message);
  }
  const failure = messages.find((message) => message.kind === "program-error");
  assert.equal(failure?.kind, "program-error");
  assert.equal(failure.error.message.length, maximumTelemetryErrorMessageLength);
  assert.match(failure.error.message, /<truncated>$/);
});

test("generated programs close after failing with a pending response read", async () => {
  const program = createProgram(
    `async ({ codemode }) => {
      void codemode.wait({});
      throw new Error("agent failed");
    }`,
  );
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(program.source).toString("base64")}`;
  const runtimeProgram = await import(moduleUrl) as {
    startProgram(channel: RuntimeInstance["channel"]): Promise<void>;
  };
  const writes: Uint8Array[] = [];
  let closed = false;

  await runtimeProgram.startProgram({
    readable: new ReadableStream({
      async pull() {
        await new Promise<never>(() => {});
      },
    }),
    writable: new WritableStream({
      write(chunk) {
        writes.push(chunk);
      },
      close() {
        closed = true;
      },
    }),
  });

  const messages = [];
  for await (const message of readProgramMessages(manyChunks(writes))) {
    messages.push(message);
  }
  assert.deepEqual(messages.map((message) => message.kind), [
    "tool-call",
    "program-error",
  ]);
  assert.equal(closed, true);
});

test("public core source does not expose Node-specific contracts", async () => {
  const coreFiles = await Promise.all([
    readFile(new URL("../index.ts", import.meta.url), "utf8"),
    readFile(new URL("./runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("./program.ts", import.meta.url), "utf8"),
    readFile(new URL("./execution.ts", import.meta.url), "utf8"),
    readFile(new URL("./protocol/codec.ts", import.meta.url), "utf8"),
    readFile(new URL("./protocol/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("./telemetry.ts", import.meta.url), "utf8"),
    readFile(new URL("./transpile.ts", import.meta.url), "utf8"),
    readFile(new URL("./types.ts", import.meta.url), "utf8"),
  ]);

  for (const file of coreFiles) {
    assert.doesNotMatch(file, /\bnode\b/i);
  }
});

function singleChunk(chunk: Uint8Array): ReadableStream<Uint8Array> {
  return manyChunks([chunk]);
}

function manyChunks(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function encodeFrameLength(frameLength: number): Uint8Array {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, frameLength, true);
  return header;
}
