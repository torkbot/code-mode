import { BSON } from "bson";

import type {
  HostMessage,
  ProgramMessage,
} from "./schema.ts";
import {
  parseHostMessage,
  parseProgramMessage,
} from "./schema.ts";

export function encodeHostMessage(message: HostMessage): Uint8Array {
  return encodeBsonFrame(asBsonDocument(parseHostMessage(message)));
}

export function encodeProgramMessage(message: ProgramMessage): Uint8Array {
  return encodeBsonFrame(asBsonDocument(parseProgramMessage(message)));
}

export async function writeHostMessage(
  outgoing: { write(chunk: Uint8Array): Promise<void> },
  message: HostMessage,
): Promise<void> {
  await outgoing.write(encodeHostMessage(message));
}

export async function* readProgramMessages(
  incoming: AsyncIterable<Uint8Array>,
): AsyncIterable<ProgramMessage> {
  for await (const document of readBsonFrames(incoming)) {
    yield parseProgramMessage(document);
  }
}

export async function* readHostMessages(
  incoming: AsyncIterable<Uint8Array>,
): AsyncIterable<HostMessage> {
  for await (const document of readBsonFrames(incoming)) {
    yield parseHostMessage(document);
  }
}

function encodeBsonFrame(document: Record<string, unknown>): Uint8Array {
  const frameSize = BSON.calculateObjectSize(document, {
    ignoreUndefined: false,
  });
  const frame = BSON.serialize(document, {
    ignoreUndefined: false,
    minInternalBufferSize: frameSize,
  } as Parameters<typeof BSON.serialize>[1] & {
    readonly minInternalBufferSize: number;
  });
  const packet = new Uint8Array(4 + frame.byteLength);
  new DataView(packet.buffer, packet.byteOffset, 4).setUint32(0, frame.byteLength, true);
  packet.set(frame, 4);
  return packet;
}

async function* readBsonFrames(
  incoming: AsyncIterable<Uint8Array>,
): AsyncIterable<Record<string, unknown>> {
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  for await (const chunk of incoming) {
    buffer = concatBytes(buffer, chunk);

    for (;;) {
      if (buffer.byteLength < 4) {
        break;
      }

      const frameLength = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0, true);
      const packetLength = 4 + frameLength;

      if (buffer.byteLength < packetLength) {
        break;
      }

      yield BSON.deserialize(buffer.subarray(4, packetLength)) as Record<string, unknown>;
      buffer = buffer.subarray(packetLength);
    }
  }

  if (buffer.byteLength > 0) {
    throw new Error("Code-mode BSON frame stream ended with a truncated frame");
  }
}

function concatBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (left.byteLength === 0) {
    return right;
  }

  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

function asBsonDocument(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}
