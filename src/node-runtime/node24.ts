import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";

import { settleBeforeAbort } from "../core/abort.ts";
import type { TypeDefinitionFile } from "../core/runtime.ts";

const require = createRequire(import.meta.url);

let cachedNode24TypeDefinitionFiles:
  | Promise<readonly TypeDefinitionFile[]>
  | undefined;

/**
 * Load the checker-only declarations for programs executed by Node.js 24.
 *
 * The package owns the matching `@types/node` and `undici-types` versions.
 * Results are cached across runtimes; each caller's signal only governs its
 * own wait for that shared work.
 *
 * @param signal Cancels this caller's wait for the declaration files.
 */
export async function loadNode24TypeDefinitionFiles(
  signal: AbortSignal,
): Promise<
  readonly TypeDefinitionFile[]
> {
  signal.throwIfAborted();
  cachedNode24TypeDefinitionFiles ??= loadNode24TypeDefinitionFilesInner();
  return await settleBeforeAbort(cachedNode24TypeDefinitionFiles, signal);
}

/**
 * Require a version reported by a Node.js executable to be Node.js 24.
 *
 * Runtime drivers remain responsible for invoking their selected executable
 * and supplying its reported version.
 *
 * @param version Trimmed output from `node --version`.
 * @param context User-facing name for the runtime being validated.
 */
export function assertNode24Version(version: string, context: string): void {
  if (!/^v24\./.test(version)) {
    throw new Error(`${context} requires Node.js 24, but reported ${version}`);
  }
}

/** Inputs for building a self-contained Node.js 24 runner bootstrap module. */
export interface Node24BootstrapSourceOptions {
  /** Self-contained source supplied to `RuntimeDriver.connect()`. */
  readonly runnerSource: string;
  /** Full-duplex socket file descriptor connected to the Runtime channel. */
  readonly channelFileDescriptor: number;
}

/**
 * Build self-contained ESM that attaches the standard runner to Node.js 24.
 *
 * The generated module multiplexes executions, evaluates every request as a
 * fresh native ESM root resolved from `process.cwd()`, and formats the passed
 * console with `node:console`. The caller owns process launch, the connected
 * file descriptor, ambient stdio, and process lifecycle.
 *
 * @param options Version-matched runner source and connected socket descriptor.
 */
export function createNode24BootstrapSource(
  options: Node24BootstrapSourceOptions,
): string {
  if (options.runnerSource.trim().length === 0) {
    throw new TypeError("Node.js 24 runner source must not be empty");
  }
  if (
    !Number.isSafeInteger(options.channelFileDescriptor)
    || options.channelFileDescriptor < 0
  ) {
    throw new TypeError(
      "Node.js 24 runner channel file descriptor must be a non-negative safe integer",
    );
  }

  return `${options.runnerSource}
import { Console } from "node:console";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { resolve } from "node:path";
import { Duplex, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

const channel = new Socket({
  fd: ${options.channelFileDescriptor},
  readable: true,
  writable: true,
  allowHalfOpen: true,
});
const programResolutionBaseUrl = pathToFileURL(
  resolve(process.cwd(), ".code-mode-program.mjs"),
).href;
const programSources = new Map();
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (programSources.has(specifier)) {
      return { shortCircuit: true, url: specifier };
    }
    if (context.parentURL?.startsWith("code-mode:program?") === true) {
      return nextResolve(specifier, {
        ...context,
        parentURL: programResolutionBaseUrl,
      });
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = programSources.get(url);
    if (source !== undefined) {
      return { format: "module", shortCircuit: true, source };
    }
    return nextLoad(url, context);
  },
});

try {
  await startRunner({
    channel: Duplex.toWeb(channel),
    schedule: (execute) => execute(),
    async importModule({ source, signal }) {
      signal.throwIfAborted();
      const programUrl = "code-mode:program?" + randomUUID();
      programSources.set(programUrl, source);
      try {
        return await import(programUrl);
      } finally {
        programSources.delete(programUrl);
      }
    },
    createConsole(emit) {
      const createStream = (stream) => new Writable({
        write(chunk, _encoding, callback) {
          try {
            emit({ stream, text: chunk.toString() });
            callback();
          } catch (error) {
            callback(error);
          }
        },
      });
      return new Console({
        stdout: createStream("stdout"),
        stderr: createStream("stderr"),
        colorMode: false,
      });
    },
  });
} finally {
  hooks.deregister();
  channel.destroy();
}
`;
}

async function loadNode24TypeDefinitionFilesInner(): Promise<
  readonly TypeDefinitionFile[]
> {
  const nodeTypesPackage = require.resolve("@types/node/package.json");
  const nodeTypesRoot = dirname(nodeTypesPackage);
  const nodeTypesRequire = createRequire(nodeTypesPackage);
  const undiciTypesRoot = dirname(
    nodeTypesRequire.resolve("undici-types/package.json"),
  );

  return [
    ...(await readTypeDefinitionPackage({
      diskRoot: nodeTypesRoot,
      virtualRoot: "node_modules/@types/node",
    })),
    ...(await readTypeDefinitionPackage({
      diskRoot: undiciTypesRoot,
      virtualRoot: "node_modules/undici-types",
    })),
  ];
}

interface ReadTypeDefinitionPackageRequest {
  readonly diskRoot: string;
  readonly virtualRoot: string;
}

async function readTypeDefinitionPackage(
  req: ReadTypeDefinitionPackageRequest,
): Promise<readonly TypeDefinitionFile[]> {
  const files: TypeDefinitionFile[] = [];

  for (const diskPath of await listTypeDefinitionFiles(req.diskRoot)) {
    const relativePath = relative(req.diskRoot, diskPath).split(sep).join("/");
    if (/^ts\d+(?:\.|\/)/.test(relativePath)) {
      continue;
    }
    files.push({
      path: `${req.virtualRoot}/${relativePath}`,
      contents: await readFile(diskPath, "utf8"),
    });
  }

  return files;
}

async function listTypeDefinitionFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, {
    recursive: true,
    withFileTypes: true,
  });
  const files: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (entry.name !== "package.json" && !entry.name.endsWith(".d.ts")) {
      continue;
    }

    files.push(join(entry.parentPath, entry.name));
  }

  return files.sort();
}
