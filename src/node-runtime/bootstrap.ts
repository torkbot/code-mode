import type { Program } from "../core/runtime.ts";

export const nodeChannelFd = 3;
export const nodeChannelFdEnvironmentVariable = "CODE_MODE_CHANNEL_FD";

export function createNodeBootstrapSource(program: Program): string {
  return `
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const channelFd = Number(process.env[${JSON.stringify(nodeChannelFdEnvironmentVariable)}]);

if (!Number.isInteger(channelFd)) {
  throw new Error("${nodeChannelFdEnvironmentVariable} must be an integer file descriptor");
}

const input = createReadStream(null, {
  fd: channelFd,
  autoClose: false,
});
const output = createWriteStream(null, {
  fd: channelFd,
  autoClose: false,
});

const programUrl = pathToFileURL(
  resolve(process.cwd(), ".code-mode-runtime-program.mjs"),
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
        source: ${JSON.stringify(program.source)},
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

await start({
  incoming: readableChunks(input),
  outgoing: {
    async write(chunk) {
      if (output.destroyed || output.writableEnded) {
        throw new Error("Code-mode byte channel is closed");
      }
      if (!output.write(chunk)) {
        await once(output, "drain");
      }
    },
    async close() {
      await closeWritable(output);
    },
  },
});

async function closeWritable(writable) {
  if (writable.destroyed || writable.writableEnded) {
    return;
  }

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      writable.off("error", onError);
      writable.off("finish", onFinish);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };

    writable.once("error", onError);
    writable.once("finish", onFinish);
    writable.end();
  });
}

async function* readableChunks(readable) {
  for await (const chunk of readable) {
    if (!(chunk instanceof Uint8Array)) {
      throw new Error("Code-mode byte channel emitted an unsupported chunk");
    }
    yield chunk;
  }
}
`;
}
