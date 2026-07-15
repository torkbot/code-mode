import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { testRuntime } from "../testing/index.ts";
import { createClient, createToolbox } from "../index.ts";
import { HostNodeRuntime } from "./index.ts";

async function createHostNodeRuntime(): Promise<HostNodeRuntime> {
  return new HostNodeRuntime(process.execPath);
}

testRuntime({
  name: "host-node runtime",
  createRuntime: createHostNodeRuntime,
});

test("host-node supplies its Node 24 checking environment", async () => {
  const runtime = new HostNodeRuntime(process.execPath);
  const typeDefinitions = await runtime.loadTypeDefinitionFiles(
    AbortSignal.timeout(5_000),
  );

  assert.equal(runtime.description, "Node.js 24");
  assertTypeDefinitionExists(typeDefinitions, "node_modules/@types/node/index.d.ts");
  assertTypeDefinitionExists(typeDefinitions, "node_modules/undici-types/index.d.ts");
  assert.equal(
    typeDefinitions.some((file) => /node_modules\/@types\/node\/ts\d/.test(file.path)),
    false,
  );
});

test("host-node runtime type definitions validate Node globals and node: imports", async () => {
  const client = createClient({
    runtime: new HostNodeRuntime(process.execPath),
    toolbox: createToolbox([]),
  });

  const validation = await client.validate(`async () => {
      console.log(process.version);
      const path = await import("node:path");
      path.join("a", "b");
    }`, AbortSignal.timeout(5_000));

  assert.deepEqual(validation, { kind: "valid" });

  const unsupportedConsole = await client.validate(
    "async () => { globalThis.console.table([]); }",
    AbortSignal.timeout(5_000),
  );
  assert.equal(unsupportedConsole.kind, "invalid");
  assert.match(unsupportedConsole.report, /Property 'table' does not exist/);

  const unsupportedGlobalConsole = await client.validate(
    "async () => { global.console.table([]); }",
    AbortSignal.timeout(5_000),
  );
  assert.equal(unsupportedGlobalConsole.kind, "invalid");
  assert.match(unsupportedGlobalConsole.report, /Property 'table' does not exist/);
});

test("host-node resolves package imports from the runtime working directory", async () => {
  const client = createClient({
    runtime: await createHostNodeRuntime(),
    toolbox: createToolbox([]),
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
  });

  assert.deepEqual(
    await client.run(`async () => {
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1_000);
    }`, { signal: AbortSignal.timeout(5_000) }),
    { kind: "success" },
  );
});

test("host-node runtime termination is idempotent", async () => {
  const runtime = await createHostNodeRuntime();
  const instance = await runtime.start({
    payload: {
      kind: "javascript-module",
      source: `export async function startProgram() {
        setInterval(() => {}, 1_000);
      }`,
    },
    signal: AbortSignal.timeout(5_000),
  });

  await Promise.all([
    instance.terminate("first termination request"),
    instance.terminate("second termination request"),
  ]);

  assert.deepEqual(await instance.finished, { kind: "closed" });
});

test("host-node streams programs larger than process argument limits", async () => {
  const runtime = await createHostNodeRuntime();
  const instance = await runtime.start({
    payload: {
      kind: "javascript-module",
      source: [
        "export async function startProgram(channel) {",
        "  const writer = channel.writable.getWriter();",
        "  await writer.close();",
        "}",
        `/* ${"x".repeat(900_000)} */`,
      ].join("\n"),
    },
    signal: AbortSignal.timeout(10_000),
  });

  for await (const _chunk of instance.channel.readable) {
    // Drain the child channel until the program exits.
  }

  assert.deepEqual(await instance.finished, { kind: "closed" });
});

test("host-node bounds stderr retained for process failures", async () => {
  const runtime = await createHostNodeRuntime();
  const instance = await runtime.start({
    payload: {
      kind: "javascript-module",
      source: `export async function startProgram(channel) {
        const writer = channel.writable.getWriter();
        await writer.close();
        process.stderr.write("x".repeat(100_000) + "stderr sentinel");
        process.exitCode = 7;
      }`,
    },
    signal: AbortSignal.timeout(10_000),
  });

  for await (const _chunk of instance.channel.readable) {
    // Drain the child channel until the program exits.
  }

  const finished = await instance.finished;
  assert.equal(finished.kind, "failed");
  assert.match(finished.error.message, /stderr sentinel/);
  assert.ok(finished.error.message.length < 66_000);
});

test("host-node readable cancellation preserves the writable half of fd 3", async () => {
  const startedAt = Date.now();
  const runtime = await createHostNodeRuntime();
  const instance = await runtime.start({
    payload: {
      kind: "javascript-module",
      source: `export async function startProgram(channel) {
        const reader = channel.readable.getReader();
        await reader.read();
        await reader.cancel();
        const writer = channel.writable.getWriter();
        await writer.write(new TextEncoder().encode("after cancel"));
        await writer.close();
      }`,
    },
    signal: AbortSignal.timeout(5_000),
  });

  const writer = instance.channel.writable.getWriter();
  await writer.write(new Uint8Array([1]));
  await writer.close();
  const chunks: Uint8Array[] = [];
  for await (const chunk of instance.channel.readable) {
    chunks.push(chunk);
  }

  assert.equal(Buffer.concat(chunks).toString("utf8"), "after cancel");
  assert.deepEqual(await instance.finished, { kind: "closed" });
  assert.ok(Date.now() - startedAt < 2_000);
});

test("host-node rejects binaries outside its Node 24 target", async () => {
  const runtime = new HostNodeRuntime("/bin/echo");

  await assert.rejects(
    runtime.loadTypeDefinitionFiles(AbortSignal.timeout(5_000)),
    /requires Node\.js 24/,
  );
});

test("host-node rejects writes when the child closes its pipe", {
  timeout: 5_000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "code-mode-node-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const immediateExitPath = join(directory, "node");
  await writeFile(immediateExitPath, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then",
    "  echo v24.0.0",
    "  exit 0",
    "fi",
    "exit 1",
    "",
  ].join("\n"));
  await chmod(immediateExitPath, 0o755);

  const runtime = new HostNodeRuntime(immediateExitPath);

  await assert.rejects(
    runtime.start({
      payload: {
        kind: "javascript-module",
        source: "x".repeat(2 * 1024 * 1024),
      },
      signal: AbortSignal.timeout(4_000),
    }),
    /EPIPE|closed|write/i,
  );
});

test("host-node reports cancellation while streaming the bootstrap", async () => {
  const controller = new AbortController();
  const reason = new Error("bootstrap cancelled");
  const runtime = new HostNodeRuntime(process.execPath);
  const start = runtime.start({
    payload: {
      kind: "javascript-module",
      source: "x".repeat(16 * 1024 * 1024),
    },
    signal: controller.signal,
  });

  controller.abort(reason);

  await assert.rejects(start, (error) => error === reason);
});

function assertTypeDefinitionExists(
  files: readonly { readonly path: string }[],
  path: string,
): void {
  assert.ok(files.some((file) => file.path === path), `missing ${path}`);
}
