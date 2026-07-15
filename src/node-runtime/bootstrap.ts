import type { RuntimePayload } from "../core/runtime.ts";

export const nodeChannelFileDescriptor = 3;

export function createNodeBootstrapSource(payload: RuntimePayload): string {
  return `
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const channelFd = ${nodeChannelFileDescriptor};

const input = createReadStream(null, {
  fd: channelFd,
  autoClose: false,
});
const output = createWriteStream(null, {
  fd: channelFd,
  autoClose: false,
});

const programUrl = pathToFileURL(
  resolve(process.cwd(), ".code-mode-runtime-payload.mjs"),
).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === programUrl) {
      return {
        shortCircuit: true,
        url: programUrl,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === programUrl) {
      return {
        format: "module",
        shortCircuit: true,
        source: ${JSON.stringify(payload.source)},
      };
    }
    return nextLoad(url, context);
  },
});
let program;
try {
  program = await import(programUrl);
} finally {
  hooks.deregister();
}
const start = program.startProgram;

if (typeof start !== "function") {
  throw new Error("Code-mode source program must export startProgram()");
}

const inputIterator = input[Symbol.asyncIterator]();
const readable = new ReadableStream({
  async pull(controller) {
    const next = await inputIterator.next();
    if (next.done) {
      controller.close();
      return;
    }
    if (!(next.value instanceof Uint8Array)) {
      controller.error(new Error("Code-mode byte channel emitted an unsupported chunk"));
      return;
    }
    controller.enqueue(next.value);
  },
  cancel() {
    input.destroy();
  },
}, { highWaterMark: 0 });
const writable = new WritableStream({
  async write(chunk) {
    if (!output.write(chunk)) {
      await once(output, "drain");
    }
  },
  async close() {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        output.off("error", onError);
        output.off("finish", onFinish);
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onFinish = () => {
        cleanup();
        resolve();
      };
      output.once("error", onError);
      output.once("finish", onFinish);
      output.end();
    });
  },
});

await start({ readable, writable });
`;
}
