import assert from "node:assert/strict";
import test from "node:test";

import { BSON, Binary } from "bson";

import {
  encodeHostMessage,
  encodeProgramMessage,
  maximumBsonFrameLength,
  readHostMessages,
  readProgramMessages,
} from "./codec.ts";

test("protocol codec writes length-prefixed BSON host messages", () => {
  const packet = encodeHostMessage({
    kind: "tool-result",
    id: "tool-1",
    result: {
      ok: true,
    },
  });
  const frameLength = new DataView(packet.buffer, packet.byteOffset, 4).getUint32(0, true);

  assert.equal(frameLength, packet.byteLength - 4);
  assert.deepEqual(BSON.deserialize(packet.subarray(4)), {
    kind: "tool-result",
    id: "tool-1",
    result: {
      ok: true,
    },
  });
});

test("protocol codec reads chunked BSON program messages", async () => {
  const left = encodeProgramMessage({
    kind: "tool-call",
    id: "call-1",
    name: "lookup",
    input: {
      query: "London",
    },
  });
  const right = encodeProgramMessage({
    kind: "completed",
  });
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left, 0);
  combined.set(right, left.byteLength);
  const chunks = [
    combined.subarray(0, 3),
    combined.subarray(3, 13),
    combined.subarray(13),
  ];

  assert.deepEqual(await collect(readProgramMessages(fromChunks(chunks))), [
    {
      kind: "tool-call",
      id: "call-1",
      name: "lookup",
      input: {
        query: "London",
      },
    },
    {
      kind: "completed",
    },
  ]);
});

test("protocol codec preserves BSON binary values", async () => {
  const packet = encodeHostMessage({
    kind: "tool-result",
    id: "binary",
    result: {
      data: new Binary(new Uint8Array([1, 2, 3])),
    },
  });
  const [message] = await collect(readHostMessages(fromChunks([packet])));

  assert.equal(message?.kind, "tool-result");
  assert.ok(message.result instanceof Object);
  assert.deepEqual(
    (message.result as { readonly data: Binary }).data.buffer,
    Buffer.from([1, 2, 3]),
  );
});

test("protocol codec rejects malformed program messages", async () => {
  const malformedMessages = [
    {
      kind: "tool-call",
      id: "call-1",
      input: {},
    },
    {
      kind: "tool-call",
      id: "call-1",
      name: 42,
      input: {},
    },
    {
      kind: "completed",
      extra: true,
    },
  ];

  for (const malformed of malformedMessages) {
    await assert.rejects(
      collect(readProgramMessages(fromChunks([encodeRawBsonFrame(malformed)]))),
      /Invalid code-mode program message/,
    );
  }
});

test("protocol codec rejects invalid frame lengths before reading a payload", async () => {
  await assert.rejects(
    collect(readProgramMessages(fromChunks([encodeFrameLength(4)]))),
    /smaller than the minimum 5/,
  );
  await assert.rejects(
    collect(readProgramMessages(fromChunks([
      encodeFrameLength(maximumBsonFrameLength + 1),
    ]))),
    /exceeds the maximum/,
  );
});

test("protocol codec rejects outbound messages above the frame limit", () => {
  assert.throws(
    () => encodeHostMessage({
      kind: "tool-result",
      id: "oversized",
      result: "x".repeat(maximumBsonFrameLength),
    }),
    /exceeds the maximum/,
  );
});

function encodeFrameLength(frameLength: number): Uint8Array {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, frameLength, true);
  return header;
}

function encodeRawBsonFrame(document: Record<string, unknown>): Uint8Array {
  const frame = BSON.serialize(document);
  const packet = new Uint8Array(4 + frame.byteLength);
  new DataView(packet.buffer, packet.byteOffset, 4).setUint32(0, frame.byteLength, true);
  packet.set(frame, 4);
  return packet;
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];

  for await (const value of values) {
    collected.push(value);
  }

  return collected;
}

function fromChunks(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}
