import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createProgram, startProgram } from "./program.ts";
import type {
  ByteChannel,
  Program,
  Runtime,
  RuntimeFinished,
  RuntimeInstance,
} from "./runtime.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("a supplied runtime receives a generated JavaScript module and exposes a byte channel", async () => {
  let observedProgram: Program | undefined;
  const observedWrites: Uint8Array[] = [];
  let outgoingClosed = false;
  let terminationReason: string | undefined;

  const channel: ByteChannel = {
    incoming: singleChunk(encoder.encode("from-runtime")),
    outgoing: {
      async write(chunk) {
        observedWrites.push(chunk);
      },
      async close() {
        outgoingClosed = true;
      },
    },
  };

  const finished: RuntimeFinished = { kind: "closed" };
  const runtime: Runtime = {
    async start(req) {
      observedProgram = req.program;

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
  const instance = await startProgram({
    runtime,
    signal: controller.signal,
    agentSource: "async () => ({ value: 42 })",
  });

  assert.equal(observedProgram?.kind, "javascript-module");
  assert.match(
    observedProgram?.source ?? "",
    /export async function startProgram\(channel\)/,
  );
  assert.doesNotMatch(observedProgram?.source ?? "", /globalThis\.__/);
  assert.doesNotMatch(observedProgram?.source ?? "", /from "flatted"/);
  assert.doesNotMatch(observedProgram?.source ?? "", /from 'flatted'/);
  assert.doesNotMatch(observedProgram?.source ?? "", /const run = \(\(/);
  assert.match(observedProgram?.source ?? "", /Bundled from flatted/);
  assert.match(observedProgram?.source ?? "", /flattedStringify/);
  assert.match(observedProgram?.source ?? "", /const createAgentProgram = \(console\) =>/);
  assert.match(observedProgram?.source ?? "", /readBsonFrames\(channel\.incoming\)/);
  assert.match(observedProgram?.source ?? "", /channel\.outgoing\.write/);
  assert.match(observedProgram?.source ?? "", /kind: "program-log"/);
  assert.match(observedProgram?.source ?? "", /codemode: new Proxy/);
  assert.match(observedProgram?.source ?? "", /async \(\) => \(\{ value: 42 \}\)/);
  assert.match(observedProgram?.source ?? "", /await run\(scope\)/);

  const chunks: Uint8Array[] = [];
  for await (const chunk of instance.channel.incoming) {
    chunks.push(chunk);
  }

  assert.equal(decoder.decode(Buffer.concat(chunks)), "from-runtime");

  await instance.channel.outgoing.write(encoder.encode("to-runtime"));
  await instance.channel.outgoing.close();
  await instance.terminate("test complete");

  assert.equal(decoder.decode(Buffer.concat(observedWrites)), "to-runtime");
  assert.equal(outgoingClosed, true);
  assert.equal(terminationReason, "test complete");
  assert.deepEqual(await instance.finished, finished);
});

test("createProgram returns a discriminated self-contained module", () => {
  const program = createProgram({
    agentSource: "async () => ({ message: 'hello from code-mode' })",
  });

  assert.equal(program.kind, "javascript-module");
  assert.match(program.source, /export async function startProgram\(channel\)/);
  assert.doesNotMatch(program.source, /globalThis\.__/);
  assert.doesNotMatch(program.source, /from "flatted"/);
  assert.doesNotMatch(program.source, /from 'flatted'/);
  assert.doesNotMatch(program.source, /const run = \(\(/);
  assert.match(program.source, /Bundled from flatted/);
  assert.match(program.source, /flattedStringify/);
  assert.match(program.source, /const createAgentProgram = \(console\) =>/);
  assert.match(program.source, /readBsonFrames\(channel\.incoming\)/);
  assert.match(program.source, /channel\.outgoing\.write/);
  assert.match(program.source, /kind: "program-log"/);
  assert.match(program.source, /codemode: new Proxy/);
  assert.match(program.source, /async \(\) => \(\{ message: 'hello from code-mode' \}\)/);
  assert.match(program.source, /await run\(scope\)/);
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

async function* singleChunk(chunk: Uint8Array): AsyncIterable<Uint8Array> {
  yield chunk;
}
