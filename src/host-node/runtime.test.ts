import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

import { testRuntime } from "../testing/index.ts";
import { createClient, createToolbox } from "../index.ts";
import { HostNodeRuntime } from "./index.ts";
import { readNode24TypeDefinitions } from "./node24.ts";

async function createHostNodeRuntime(): Promise<HostNodeRuntime> {
  return new HostNodeRuntime(process.execPath);
}

testRuntime({
  name: "host-node runtime",
  createRuntime: createHostNodeRuntime,
});

test("host-node exports reusable Node 24 type definitions", async () => {
  const typeDefinitions = await readNode24TypeDefinitions();

  assertTypeDefinitionExists(typeDefinitions, "node_modules/@types/node/index.d.ts");
  assertTypeDefinitionExists(typeDefinitions, "node_modules/undici-types/index.d.ts");
});

test("host-node runtime type definitions validate Node globals and node: imports", async () => {
  const client = createClient({
    runtime: new HostNodeRuntime(process.execPath),
    toolbox: createToolbox([]),
    environment: {
      description: `Node.js ${process.version}`,
      typeDefinitionFiles: await readNode24TypeDefinitions(),
    },
  });

  const validation = await client.validate(`async () => {
      console.log(process.version);
      const path = await import("node:path");
      path.join("a", "b");
    }`, AbortSignal.timeout(5_000));

  assert.deepEqual(validation, { kind: "valid" });

  const unsupportedConsole = await client.validate(
    "async () => { console.table([]); }",
    AbortSignal.timeout(5_000),
  );
  assert.equal(unsupportedConsole.kind, "invalid");
  assert.match(unsupportedConsole.report, /Property 'table' does not exist/);
});

test("host-node resolves package imports from the runtime working directory", async () => {
  const client = createClient({
    runtime: await createHostNodeRuntime(),
    toolbox: createToolbox([]),
    environment: {
      description: `Node.js ${process.version}`,
      typeDefinitionFiles: [],
    },
  });

  assert.deepEqual(
    await client.run(`async () => {
      const bson = await import("bson");
      if (typeof bson.BSON.serialize !== "function") throw new Error("missing bson");
    }`, { signal: AbortSignal.timeout(5_000) }),
    { kind: "success" },
  );
});

test("host-node escalates termination when a program ignores SIGTERM", async () => {
  const client = createClient({
    runtime: await createHostNodeRuntime(),
    toolbox: createToolbox([]),
    environment: {
      description: `Node.js ${process.version}`,
      typeDefinitionFiles: [],
    },
  });

  assert.deepEqual(
    await client.run(`async () => {
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1_000);
    }`, { signal: AbortSignal.timeout(5_000) }),
    { kind: "success" },
  );
});

test("host-node streams programs larger than process argument limits", async () => {
  const runtime = await createHostNodeRuntime();
  const instance = await runtime.start({
    program: {
      source: [
        "export async function startProgram(channel) {",
        "  await channel.outgoing.close();",
        "}",
        `/* ${"x".repeat(900_000)} */`,
      ].join("\n"),
    },
    signal: AbortSignal.timeout(10_000),
  });

  for await (const _chunk of instance.channel.incoming) {
    // Drain the child channel until the program exits.
  }

  assert.deepEqual(await instance.finished, { kind: "closed" });
});

test("host-node bounds stderr retained for process failures", async () => {
  const runtime = await createHostNodeRuntime();
  const instance = await runtime.start({
    program: {
      source: `export async function startProgram(channel) {
        await channel.outgoing.close();
        process.stderr.write("x".repeat(100_000) + "stderr sentinel");
        process.exitCode = 7;
      }`,
    },
    signal: AbortSignal.timeout(10_000),
  });

  for await (const _chunk of instance.channel.incoming) {
    // Drain the child channel until the program exits.
  }

  const finished = await instance.finished;
  assert.equal(finished.kind, "failed");
  assert.match(finished.error.message, /stderr sentinel/);
  assert.ok(finished.error.message.length < 66_000);
});

test("host-node rejects writes when the child closes its pipe", {
  timeout: 5_000,
}, async (t) => {
  const immediateExitPath = "/usr/bin/false";
  try {
    await access(immediateExitPath);
  } catch {
    t.skip(`${immediateExitPath} is not available`);
    return;
  }

  const runtime = new HostNodeRuntime(immediateExitPath);

  await assert.rejects(
    runtime.start({
      program: {
        source: "x".repeat(2 * 1024 * 1024),
      },
      signal: AbortSignal.timeout(4_000),
    }),
    /EPIPE|closed|write/i,
  );
});

function assertTypeDefinitionExists(
  files: readonly { readonly path: string }[],
  path: string,
): void {
  assert.ok(files.some((file) => file.path === path), `missing ${path}`);
}
