import type { Program } from "./runtime.ts";
import { bsonRuntimeSource } from "../runtime-code/bson.ts";
import {
  agentProgramFactoryName,
  transpileAgentSource,
} from "./transpile.ts";
import {
  bsonFrameHeaderLength,
  maximumBsonFrameLength,
  minimumBsonDocumentLength,
} from "./protocol/limits.ts";
import {
  maximumTelemetryErrorMessageLength,
  maximumTelemetryErrorNameLength,
  maximumTelemetryErrorReportLength,
  maximumTelemetryErrorStackLength,
} from "./telemetry.ts";

export function createProgram(agentSource: string): Program {
  const transpilation = transpileAgentSource(agentSource);
  if (transpilation.kind === "invalid") {
    throw new AgentSourceSyntaxError(transpilation.report);
  }

  return {
    source: createRuntimeProgramSource(transpilation.source),
  };
}

export class AgentSourceSyntaxError extends SyntaxError {
  constructor(report: string) {
    super(report);
    this.name = "SyntaxError";
  }
}

function createRuntimeProgramSource(agentProgramJavaScript: string): string {
  return `
${bsonRuntimeSource}

const bsonFrameHeaderLength = ${bsonFrameHeaderLength};
const minimumBsonDocumentLength = ${minimumBsonDocumentLength};
const maximumBsonFrameLength = ${maximumBsonFrameLength};
const maximumTelemetryErrorNameLength = ${maximumTelemetryErrorNameLength};
const maximumTelemetryErrorMessageLength = ${maximumTelemetryErrorMessageLength};
const maximumTelemetryErrorStackLength = ${maximumTelemetryErrorStackLength};
const maximumTelemetryErrorReportLength = ${maximumTelemetryErrorReportLength};

${agentProgramJavaScript}
const flattedStringify = createFlattedStringify();

// Bundled from flatted, ISC License, Copyright (c) Andrea Giammarchi, @WebReflection.
function createFlattedStringify() {
  const { stringify: jsonStringify } = JSON;
  const Primitive = String;
  const primitive = "string";
  const object = "object";
  const noop = (_key, value) => value;
  const set = (known, input, value) => {
    const index = Primitive(input.push(value) - 1);
    known.set(value, index);
    return index;
  };

  return (value, replacer, space) => {
    const replaceValue = replacer && typeof replacer === object
      ? (key, currentValue) => (
        key === "" || -1 < replacer.indexOf(key) ? currentValue : undefined
      )
      : (replacer || noop);
    const known = new Map();
    const input = [];
    const output = [];
    let i = +set(known, input, replaceValue.call({ "": value }, "", value));
    let firstRun = !i;

    while (i < input.length) {
      firstRun = true;
      output[i] = jsonStringify(input[i++], replace, space);
    }

    return "[" + output.join(",") + "]";

    function replace(key, currentValue) {
      if (firstRun) {
        firstRun = !firstRun;
        return currentValue;
      }

      const after = replaceValue.call(this, key, currentValue);

      switch (typeof after) {
        case object:
          if (after === null) {
            return after;
          }
        case primitive:
          return known.get(after) || set(known, input, after);
      }

      return after;
    }
  };
}

export async function startProgram(channel) {
  let nextToolCallId = 0;
  const responses = readBsonFrames(channel.incoming)[Symbol.asyncIterator]();
  const pendingToolCalls = new Map();
  const unobservedToolCalls = new Map();
  let responsePump;
  let writeQueue = Promise.resolve();
  const scope = {
    codemode: new Proxy({}, {
      get(_target, property) {
        if (typeof property !== "string") {
          return undefined;
        }
        if (property === "then") {
          return undefined;
        }

        return (input) => {
          const id = String(nextToolCallId++);
          const call = (async () => {
            const response = waitForToolResponse(id, property);

            try {
              await enqueueProgramMessage({
                kind: "tool-call",
                id,
                name: property,
                input,
              });
            } catch (error) {
              pendingToolCalls.delete(id);
              throw error;
            }

            return response;
          })();
          return trackToolCall(id, call);
        };
      },
    }),
  };

  try {
    const programConsole = createProgramConsole(emitProgramLog);
    let programGlobalThis;
    programGlobalThis = new Proxy(globalThis, {
      get(target, property, receiver) {
        if (property === "console") return programConsole;
        if (property === "globalThis") return programGlobalThis;
        return Reflect.get(target, property, receiver);
      },
    });
    const run = ${agentProgramFactoryName}(programConsole, programGlobalThis);
    const result = await run(scope);
    if (result !== undefined) {
      throw new Error("Code-mode agent program must resolve to undefined");
    }
    if (pendingToolCalls.size > 0) {
      throw new Error("Code-mode agent program must await every tool call before completing");
    }
    for (const unobservedError of unobservedToolCalls.values()) {
      if (unobservedError !== undefined) {
        throw unobservedError;
      }
    }
    if (unobservedToolCalls.size > 0) {
      throw new Error("Code-mode agent program must await every tool call before completing");
    }

    await writeQueue;
    await enqueueProgramMessage({
      kind: "completed",
    });
    await writeQueue;
    await channel.outgoing.close();
  } catch (error) {
    await enqueueProgramMessage({
      kind: "program-error",
      error: serializeError(error),
    });
    await writeQueue.catch(() => {});
    await channel.outgoing.close();
  }

  function waitForToolResponse(id, name) {
    const response = new Promise((resolve, reject) => {
      pendingToolCalls.set(id, {
        name,
        resolve,
        reject,
      });
    });

    ensureResponsePump();
    return response;
  }

  function trackToolCall(id, call) {
    let observed = false;
    unobservedToolCalls.set(id, undefined);
    void call.catch((error) => {
      if (!observed) {
        unobservedToolCalls.set(id, error);
      }
    });

    return new Proxy(call, {
      get(target, property) {
        if (property === "then" || property === "catch" || property === "finally") {
          return (...args) => {
            observed = true;
            unobservedToolCalls.delete(id);
            const derived = target[property](...args);
            return property === "then" && typeof args[1] === "function"
              ? derived
              : trackToolCall(id, derived);
          };
        }

        return Reflect.get(target, property, target);
      },
    });
  }

  function ensureResponsePump() {
    if (responsePump !== undefined) {
      return;
    }

    responsePump = pumpResponses().finally(() => {
      responsePump = undefined;

      if (pendingToolCalls.size > 0) {
        ensureResponsePump();
      }
    });
  }

  async function pumpResponses() {
    try {
      while (pendingToolCalls.size > 0) {
        const next = await responses.next();

        if (next.done === true) {
          rejectPendingToolCalls(
            new Error("Code-mode tool response channel ended while calls were pending"),
          );
          return;
        }

        const response = next.value;
        const pending = pendingToolCalls.get(response.id);

        if (pending === undefined) {
          continue;
        }

        pendingToolCalls.delete(response.id);

        if (response.kind === "tool-result") {
          pending.resolve(response.result);
          continue;
        }

        if (response.kind === "tool-error") {
          pending.reject(errorFromSerializedError(response.error));
          continue;
        }

        pending.reject(
          new Error(\`Unsupported code-mode tool response kind: \${String(response.kind)}\`),
        );
      }
    } catch (error) {
      rejectPendingToolCalls(error);
    }
  }

  function rejectPendingToolCalls(error) {
    for (const pending of pendingToolCalls.values()) {
      pending.reject(error);
    }

    pendingToolCalls.clear();
  }

  function enqueueProgramMessage(message) {
    const write = writeQueue.then(async () => {
      await channel.outgoing.write(encodeBsonFrame(message));
    });
    writeQueue = write.catch(() => {});
    return write;
  }

  function emitTelemetry(event) {
    void enqueueProgramMessage({
      kind: "telemetry",
      event,
    }).catch(() => {});
  }

  function emitProgramLog(level, values) {
    const serializedValues = values.map(serializeConsoleValue);
    const displayValues = values.map((value, index) => {
      const serialized = serializedValues[index];
      return formatConsoleDisplayValue(value, serialized);
    });

    emitTelemetry({
      kind: "program-log",
      level,
      message: displayValues.join(" "),
      values: serializedValues,
    });
  }

  function createProgramConsole(log) {
    return {
      debug: (...values) => log("debug", values),
      error: (...values) => log("error", values),
      info: (...values) => log("info", values),
      log: (...values) => log("log", values),
      warn: (...values) => log("warn", values),
    };
  }

  function serializeConsoleValue(value) {
    const marker = crypto.randomUUID();
    const encodeValue = (_key, nested) => encodeConsoleValue(marker, nested);
    try {
      return {
        format: "flatted",
        value: flattedStringify({ marker, value }, encodeValue),
      };
    } catch (error) {
      return {
        format: "flatted",
        value: flattedStringify({ marker, value: {
          $type: "serialization-error",
          marker,
          error: serializeError(error),
        } }, encodeValue),
      };
    }
  }

  function encodeConsoleValue(marker, value) {
    if (value instanceof Error) {
      return {
        $type: "error",
        marker,
        name: value.name,
        message: value.message,
        stack: value.stack ?? null,
      };
    }

    if (typeof value === "bigint") {
      return {
        $type: "bigint",
        marker,
        value: String(value),
      };
    }

    if (typeof value === "function") {
      return {
        $type: "function",
        marker,
        name: value.name || null,
      };
    }

    if (typeof value === "symbol") {
      return {
        $type: "symbol",
        marker,
        value: String(value),
      };
    }

    if (typeof value === "undefined") {
      return {
        $type: "undefined",
        marker,
      };
    }

    return value;
  }

  function formatConsoleDisplayValue(value, serialized) {
    if (typeof value === "string") {
      return value;
    }

    if (value instanceof Error) {
      return value.stack ?? value.message;
    }

    return serialized.value;
  }

  function serializeError(error) {
    if (error instanceof Error) {
      const stack = readErrorString(error, "stack", null);
      return {
        name: truncateErrorField(
          readErrorString(error, "name", "Error"),
          maximumTelemetryErrorNameLength,
        ),
        message: truncateErrorField(
          readErrorString(
            error,
            "message",
            "Code-mode error message could not be read",
          ),
          maximumTelemetryErrorMessageLength,
        ),
        stack: stack === null
          ? null
          : truncateErrorField(stack, maximumTelemetryErrorStackLength),
        details: serializeErrorDetails(readErrorDetailsValue(error)),
      };
    }

    return {
      name: "Error",
      message: truncateErrorField(
        stringifyUnknownError(error),
        maximumTelemetryErrorMessageLength,
      ),
      stack: null,
      details: null,
    };
  }

  function errorFromSerializedError(error) {
    const value = new Error(error.message);
    value.name = error.name;

    if (error.stack !== null) {
      value.stack = error.stack;
    }

    if (error.details !== null) {
      value.details = error.details;
    }

    return value;
  }

  function serializeErrorDetails(value) {
    if (value === null || typeof value !== "object") {
      return null;
    }

    try {
      if (value.kind !== "tool-validation" || typeof value.report !== "string") {
        return null;
      }

      return {
        kind: "tool-validation",
        report: truncateErrorField(
          value.report,
          maximumTelemetryErrorReportLength,
        ),
      };
    } catch {
      return null;
    }
  }

  function readErrorDetailsValue(error) {
    try {
      return error.details;
    } catch {
      return null;
    }
  }

  function readErrorString(error, property, fallback) {
    try {
      const value = error[property];
      return typeof value === "string" ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function stringifyUnknownError(error) {
    try {
      return String(error);
    } catch {
      return "Code-mode thrown value could not be serialized";
    }
  }

  function truncateErrorField(value, maximumLength) {
    if (value.length <= maximumLength) {
      return value;
    }

    const suffix = "... <truncated>";
    return value.slice(0, maximumLength - suffix.length) + suffix;
  }
}

function encodeBsonFrame(message) {
  const frameSize = BSON.calculateObjectSize(message, {
    ignoreUndefined: false,
  });
  assertValidFrameLength(frameSize);
  const frame = BSON.serialize(message, {
    ignoreUndefined: false,
    minInternalBufferSize: frameSize,
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

async function* readBsonFrames(incoming) {
  const header = new Uint8Array(bsonFrameHeaderLength);
  let headerLength = 0;
  let frame;

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
        yield BSON.deserialize(frame.bytes);
        headerLength = 0;
        frame = undefined;
      }
    }
  }

  if (headerLength > 0 || frame !== undefined) {
    throw new Error("Code-mode BSON frame stream ended with a truncated frame");
  }
}

function assertValidFrameLength(frameLength) {
  if (frameLength < minimumBsonDocumentLength) {
    throw new Error(
      \`Code-mode BSON frame length \${frameLength} is smaller than the minimum \${minimumBsonDocumentLength}\`,
    );
  }
  if (frameLength > maximumBsonFrameLength) {
    throw new Error(
      \`Code-mode BSON frame length \${frameLength} exceeds the maximum \${maximumBsonFrameLength}\`,
    );
  }
}
`;
}
