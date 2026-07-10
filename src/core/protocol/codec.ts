import { BSON } from "bson";

import type {
  HostMessage,
  ProgramMessage,
} from "./schema.ts";
import {
  parseHostMessage,
  parseProgramMessage,
} from "./schema.ts";
import {
  bsonFrameHeaderLength,
  maximumBsonFrameLength,
  minimumBsonDocumentLength,
} from "./limits.ts";

export { maximumBsonFrameLength } from "./limits.ts";

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
  assertValidFrameLength(frameSize);
  const frame = BSON.serialize(document, {
    ignoreUndefined: false,
    minInternalBufferSize: frameSize,
  } as Parameters<typeof BSON.serialize>[1] & {
    readonly minInternalBufferSize: number;
  });
  const packet = new Uint8Array(bsonFrameHeaderLength + frame.byteLength);
  new DataView(
    packet.buffer,
    packet.byteOffset,
    bsonFrameHeaderLength,
  ).setUint32(0, frame.byteLength, true);
  packet.set(frame, bsonFrameHeaderLength);
  return packet;
}

async function* readBsonFrames(
  incoming: AsyncIterable<Uint8Array>,
): AsyncIterable<Record<string, unknown>> {
  const header = new Uint8Array(bsonFrameHeaderLength);
  let headerLength = 0;
  let frame: FrameState | undefined;

  for await (const chunk of incoming) {
    let offset = 0;

    while (offset < chunk.byteLength) {
      if (frame === undefined) {
        const headerBytes = Math.min(
          bsonFrameHeaderLength - headerLength,
          chunk.byteLength - offset,
        );
        header.set(chunk.subarray(offset, offset + headerBytes), headerLength);
        headerLength += headerBytes;
        offset += headerBytes;

        if (headerLength < bsonFrameHeaderLength) {
          continue;
        }

        const frameLength = new DataView(
          header.buffer,
          header.byteOffset,
          bsonFrameHeaderLength,
        ).getUint32(0, true);
        assertValidFrameLength(frameLength);
        frame = {
          bytes: new Uint8Array(frameLength),
          receivedLength: 0,
        };
      }

      const frameBytes = Math.min(
        frame.bytes.byteLength - frame.receivedLength,
        chunk.byteLength - offset,
      );
      frame.bytes.set(
        chunk.subarray(offset, offset + frameBytes),
        frame.receivedLength,
      );
      frame.receivedLength += frameBytes;
      offset += frameBytes;

      if (frame.receivedLength === frame.bytes.byteLength) {
        yield BSON.deserialize(frame.bytes) as Record<string, unknown>;
        headerLength = 0;
        frame = undefined;
      }
    }
  }

  if (headerLength > 0 || frame !== undefined) {
    throw new Error("Code-mode BSON frame stream ended with a truncated frame");
  }
}

interface FrameState {
  readonly bytes: Uint8Array<ArrayBufferLike>;
  receivedLength: number;
}

function assertValidFrameLength(frameLength: number): void {
  if (frameLength < minimumBsonDocumentLength) {
    throw new Error(
      `Code-mode BSON frame length ${frameLength} is smaller than the minimum ${minimumBsonDocumentLength}`,
    );
  }
  if (frameLength > maximumBsonFrameLength) {
    throw new Error(
      `Code-mode BSON frame length ${frameLength} exceeds the maximum ${maximumBsonFrameLength}`,
    );
  }
}

function asBsonDocument(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}
