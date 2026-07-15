import type { RuntimePayload } from "../core/runtime.ts";

export const nodeChannelFileDescriptor = 3;

export function createNodeBootstrapSource(payload: RuntimePayload): string {
  return `
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { resolve } from "node:path";
import { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";

const channelFd = ${nodeChannelFileDescriptor};

const channel = new Socket({
  fd: channelFd,
  readable: true,
  writable: true,
  allowHalfOpen: true,
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

try {
  await start(Duplex.toWeb(channel));
} finally {
  channel.destroy();
}
`;
}
