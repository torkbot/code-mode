import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runnerSource } from "./runner/source.ts";

test("package exports the client, runtime-author, runner, Node authoring, host-node, and testing surfaces", async () => {
  const packageJson = JSON.parse(await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  )) as {
    readonly exports: Readonly<Record<string, unknown>>;
    readonly dependencies: Readonly<Record<string, string>>;
  };

  assert.deepEqual(Object.keys(packageJson.exports), [
    ".",
    "./runtime",
    "./runner",
    "./runner/source",
    "./node-runtime",
    "./host-node",
    "./testing",
  ]);
  assert.equal(packageJson.dependencies["bson"], undefined);
  assert.equal(packageJson.dependencies["flatted"], undefined);
});

test("runtime-author surface exposes the complete driver and connected-runtime contract", async () => {
  const runtime = await readFile(
    new URL("./runtime/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(runtime, /RuntimeDriver/);
  assert.match(runtime, /RuntimeConnection/);
  assert.match(runtime, /RuntimeFactory/);
  assert.match(runtime, /createRuntimeFactory/);
  assert.match(runtime, /RuntimeExecuteRequest/);
  assert.match(runtime, /RuntimeProgramOutput/);
  assert.doesNotMatch(runtime, /RuntimePayload|RuntimeInstance|RuntimeStartRequest/);
});

test("runner ships as both a normal module and self-contained source", async () => {
  const runner = await readFile(
    new URL("./runner/index.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(runner, /^import /m);
  assert.match(runner, /export async function startRunner/);
  assert.match(runnerSource, /^export async function startRunner/);
  assert.doesNotMatch(runnerSource, /^import /m);

  const encoded = Buffer.from(runnerSource).toString("base64");
  const loaded = await import(`data:text/javascript;base64,${encoded}`) as {
    readonly startRunner?: unknown;
  };
  assert.equal(typeof loaded.startRunner, "function");
});

test("Node runtime authoring surface owns Node 24 declarations and guest bootstrap semantics", async () => {
  const nodeRuntime = await readFile(
    new URL("./node-runtime/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(nodeRuntime, /assertNode24Version/);
  assert.match(nodeRuntime, /createNode24BootstrapSource/);
  assert.match(nodeRuntime, /loadNode24TypeDefinitionFiles/);
  assert.doesNotMatch(nodeRuntime, /spawn|execFile|RuntimeConnection/);
});

test("host-node is a factory over the public runtime-driver seam", async () => {
  const hostNode = await readFile(
    new URL("./host-node/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(hostNode, /createHostNodeRuntime/);
  assert.match(hostNode, /createRuntimeFactory/);
  assert.match(hostNode, /RuntimeDriver<HostNodeRuntimeOptions>/);
  assert.match(hostNode, /createNode24BootstrapSource/);
  assert.doesNotMatch(hostNode, /class HostNodeRuntime|class Node24Runtime/);
  assert.doesNotMatch(hostNode, /registerHooks|programSources|createStream/);
});

test("conformance tests cross only the public runtime and client interfaces", async () => {
  const conformance = await readFile(
    new URL("./testing/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(conformance, /testRuntime/);
  assert.match(
    conformance,
    /createRuntime\(signal: AbortSignal\): Promise<Runtime>/,
  );
  assert.match(conformance, /runtime\.execute/);
  assert.match(conformance, /createClient/);
  assert.doesNotMatch(
    conformance,
    /RuntimeConnection|createRuntimeFactory|startRunner|channel\./,
  );
});

test("superseded execution layers and contracts are absent", async () => {
  const files = await Promise.all([
    "./core/client.ts",
    "./core/runtime.ts",
    "./core/telemetry.ts",
    "./core/transpile.ts",
    "./host-node/index.ts",
    "./runner/index.ts",
  ].map(async (path) => readFile(new URL(path, import.meta.url), "utf8")));
  const source = files.join("\n");

  assert.doesNotMatch(source, /Runtime\.start|RuntimeInstance|RuntimePayload/);
  assert.doesNotMatch(source, /createProgram|startProgram/);
  assert.doesNotMatch(source, /program-log|CodeModeGlobalThis/);
  assert.doesNotMatch(source, /flatted|createProgramPromise|programGlobalThis/);
});
