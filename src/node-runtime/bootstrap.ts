import type { Program } from "../core/runtime.ts";
import { programEntrypointName } from "../core/runtime.ts";

export const nodeChannelFd = 3;
export const nodeChannelFdEnvironmentVariable = "CODE_MODE_CHANNEL_FD";

export function createNodeBootstrapSource(program: Program): string {
  switch (program.kind) {
    case "javascript-module":
      return createJavaScriptModuleBootstrap(program.source);
  }
}

function createJavaScriptModuleBootstrap(source: string): string {
  const programUrl = `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
  return `
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";

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

const program = await import(${JSON.stringify(programUrl)});
const start = program[${JSON.stringify(programEntrypointName)}];

if (typeof start !== "function") {
  throw new Error("Code-mode source program must export ${programEntrypointName}()");
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
