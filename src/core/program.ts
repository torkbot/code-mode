import type { Program, Runtime, RuntimeInstance } from "./runtime.ts";
import { programEntrypointName } from "./runtime.ts";
import { bsonRuntimeSource } from "../runtime-code/bson.ts";
import {
  agentProgramVariableName,
  transpileAgentSource,
} from "./transpile.ts";

export interface AgentProgramScope<TApi = unknown> {
  readonly codemode: TApi;
}

export type AgentProgram<TApi = unknown> = (
  scope: AgentProgramScope<TApi>,
) => Promise<void>;

export interface CreateProgramRequest {
  readonly agentSource: string;
}

export interface StartProgramRequest {
  readonly runtime: Runtime;
  readonly signal: AbortSignal;
  readonly agentSource: string;
}

export function createProgram(req: CreateProgramRequest): Program {
  const transpilation = transpileAgentSource(req.agentSource);
  if (transpilation.kind === "invalid") {
    throw new AgentSourceSyntaxError(transpilation.report);
  }

  return {
    kind: "javascript-module",
    source: createRuntimeProgramSource(transpilation.source),
  };
}

export async function startProgram(
  req: StartProgramRequest,
): Promise<RuntimeInstance> {
  const program = createProgram({
    agentSource: req.agentSource,
  });

  return await req.runtime.start({
    program,
    signal: req.signal,
  });
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

const createAgentProgram = (console) => {
${agentProgramJavaScript}
  return ${agentProgramVariableName};
};
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

export async function ${programEntrypointName}(channel) {
  let nextToolCallId = 0;
  const responses = readBsonFrames(channel.incoming)[Symbol.asyncIterator]();
  const pendingToolCalls = new Map();
  let responsePump;
  let writeQueue = Promise.resolve();
  const run = createAgentProgram(createProgramConsole(emitProgramLog));
  const scope = {
    codemode: new Proxy({}, {
      get(_target, property) {
        if (typeof property !== "string") {
          return undefined;
        }

        return async (input) => {
          const id = String(nextToolCallId++);
          const response = waitForToolResponse(id, property);

          try {
            await enqueueProgramMessage({
              kind: "tool-call",
              id,
              name: property,
              input,
              stack: captureToolCallStack(),
            });
          } catch (error) {
            pendingToolCalls.delete(id);
            throw error;
          }

          return await response;
        };
      },
    }),
  };

  try {
    emitTelemetry({
      kind: "program-started",
    });

    const result = await run(scope);
    if (result !== undefined) {
      throw new Error("Code-mode agent program must resolve to undefined");
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

  function captureToolCallStack() {
    const stack = new Error("Tool call stack").stack;
    return typeof stack === "string" ? stack : "";
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
    try {
      return {
        format: "flatted",
        value: flattedStringify(value, encodeConsoleValue),
      };
    } catch (error) {
      return {
        format: "flatted",
        value: flattedStringify({
          $type: "serialization-error",
          error: serializeError(error),
        }, encodeConsoleValue),
      };
    }
  }

  function encodeConsoleValue(_key, value) {
    if (value instanceof Error) {
      return {
        $type: "error",
        name: value.name,
        message: value.message,
        stack: value.stack ?? null,
      };
    }

    if (typeof value === "bigint") {
      return {
        $type: "bigint",
        value: String(value),
      };
    }

    if (typeof value === "function") {
      return {
        $type: "function",
        name: value.name || null,
      };
    }

    if (typeof value === "symbol") {
      return {
        $type: "symbol",
        value: String(value),
      };
    }

    if (typeof value === "undefined") {
      return {
        $type: "undefined",
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
      return {
        name: error.name,
        message: error.message,
        stack: error.stack ?? null,
        details: isErrorDetails(error.details) ? error.details : null,
      };
    }

    return {
      name: "Error",
      message: String(error),
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

  function isErrorDetails(value) {
    return value !== null
      && typeof value === "object"
      && value.kind === "tool-validation"
      && typeof value.report === "string";
  }
}

function encodeBsonFrame(message) {
  const frameSize = BSON.calculateObjectSize(message, {
    ignoreUndefined: false,
  });
  const frame = BSON.serialize(message, {
    ignoreUndefined: false,
    minInternalBufferSize: frameSize,
  });
  const packet = new Uint8Array(4 + frame.byteLength);
  new DataView(packet.buffer, packet.byteOffset, 4).setUint32(0, frame.byteLength, true);
  packet.set(frame, 4);
  return packet;
}

async function* readBsonFrames(incoming) {
  let buffer = new Uint8Array(0);

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

      yield BSON.deserialize(buffer.subarray(4, packetLength));
      buffer = buffer.subarray(packetLength);
    }
  }

  if (buffer.byteLength > 0) {
    throw new Error("Code-mode BSON frame stream ended with a truncated frame");
  }
}

function concatBytes(left, right) {
  if (left.byteLength === 0) {
    return right;
  }

  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}
`;
}
