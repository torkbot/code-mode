import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public runtime, Node adapter, host-node, and testing exports are declared", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    readonly dependencies: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
    readonly scripts: Record<string, string>;
    readonly exports: Record<string, {
      readonly types: string;
      readonly default: string;
    }>;
  };

  assert.deepEqual(packageJson.exports["."], {
    types: "./dist/index.d.ts",
    default: "./dist/index.js",
  });
  assert.deepEqual(packageJson.exports["./runtime"], {
    types: "./dist/runtime/index.d.ts",
    default: "./dist/runtime/index.js",
  });
  assert.deepEqual(packageJson.exports["./node"], {
    types: "./dist/node/index.d.ts",
    default: "./dist/node/index.js",
  });
  assert.deepEqual(packageJson.exports["./host-node"], {
    types: "./dist/host-node/index.d.ts",
    default: "./dist/host-node/index.js",
  });
  assert.equal(packageJson.exports["./host-node/node24"], undefined);
  assert.equal(packageJson.exports["./sandbox-node"], undefined);
  assert.deepEqual(packageJson.exports["./testing"], {
    types: "./dist/testing/index.d.ts",
    default: "./dist/testing/index.js",
  });
  assert.equal(
    packageJson.scripts["types:generate"],
    "rm -rf dist && tsc --project tsconfig.build.json --pretty --emitDeclarationOnly",
  );
  assert.equal(packageJson.dependencies["@typescript/native-preview"], undefined);
  assert.equal(typeof packageJson.dependencies["typescript"], "string");
  assert.equal(typeof packageJson.dependencies["amaro"], "string");
  assert.equal(typeof packageJson.dependencies["@standard-schema/spec"], "string");
  assert.equal(typeof packageJson.dependencies["@types/node"], "string");
  assert.equal(typeof packageJson.dependencies["bson"], "string");
  assert.equal(typeof packageJson.dependencies["typebox"], "string");
  assert.equal(packageJson.devDependencies?.["typescript"], undefined);
  assert.equal(packageJson.devDependencies?.["@types/node"], undefined);
  assert.equal(packageJson.devDependencies?.["typebox"], undefined);
});

test("public root export is focused on toolbox and client APIs", async () => {
  const rootExport = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const hostNodeExport = await readFile(
    new URL("./host-node/index.ts", import.meta.url),
    "utf8",
  );

  assert.match(rootExport, /createToolbox/);
  assert.match(rootExport, /defineTool/);
  assert.match(rootExport, /createClient/);
  assert.match(rootExport, /Toolbox/);
  assert.match(rootExport, /Client/);
  assert.match(rootExport, /RunOutcome/);
  assert.match(rootExport, /TelemetryEvent/);
  assert.match(rootExport, /Runtime/);
  assert.match(rootExport, /TypeDefinitionFile/);
  assert.match(rootExport, /ToolSchema/);

  assert.doesNotMatch(rootExport, /CodeModeRuntime/);

  assert.doesNotMatch(rootExport, /execute/);
  assert.doesNotMatch(rootExport, /generateTypes/);
  assert.doesNotMatch(rootExport, /serializeAgentProgram/);
  assert.doesNotMatch(rootExport, /createProgram/);
  assert.doesNotMatch(rootExport, /startProgram/);
  assert.doesNotMatch(rootExport, /ByteChannel/);
  assert.doesNotMatch(hostNodeExport, /readNode24TypeDefinitions/);
});

test("runtime-author and Node adapter exports expose the complete ownership boundary", async () => {
  const runtimeExport = await readFile(
    new URL("./runtime/index.ts", import.meta.url),
    "utf8",
  );
  const runtimeContract = await readFile(
    new URL("./core/runtime.ts", import.meta.url),
    "utf8",
  );
  const nodeAdapter = await readFile(
    new URL("./node/index.ts", import.meta.url),
    "utf8",
  );

  for (const typeName of [
    "ByteChannel",
    "ByteWriter",
    "Runtime",
    "RuntimeFinished",
    "RuntimeInstance",
    "RuntimePayload",
    "RuntimeStartRequest",
    "TypeDefinitionFile",
  ]) {
    assert.match(runtimeExport, new RegExp(`\\b${typeName}\\b`));
  }

  assert.match(runtimeContract, /readonly payload: RuntimePayload/);
  assert.match(runtimeContract, /readonly kind: "javascript-module"/);
  assert.match(runtimeContract, /startProgram\(channel\)/);
  assert.match(runtimeContract, /other endpoint/);
  assert.match(runtimeContract, /Runtime failures are values/);
  assert.match(runtimeContract, /Calls are\s+\* idempotent/);

  assert.match(nodeAdapter, /class Node24Runtime implements Runtime/);
  assert.match(nodeAdapter, /interface Node24RuntimeHost/);
  assert.match(nodeAdapter, /launchNode\(req: Node24RuntimeLaunchRequest\)/);
  assert.match(nodeAdapter, /createNodeBootstrapSource\(req\.payload\)/);
  assert.doesNotMatch(nodeAdapter, /node:child_process|@torkbot\/sandbox|Sandbox/);
});

test("runtime owns its description and checking type definitions", async () => {
  const runtime = await readFile(new URL("./core/runtime.ts", import.meta.url), "utf8");
  const client = await readFile(new URL("./core/client.ts", import.meta.url), "utf8");

  assert.match(runtime, /readonly description: string/);
  assert.match(
    runtime,
    /loadTypeDefinitionFiles\(\s*signal: AbortSignal,?\s*\)/,
  );
  assert.match(runtime, /interface TypeDefinitionFile/);
  assert.match(client, /req\.runtime\.loadTypeDefinitionFiles\(signal\)/);
  assert.doesNotMatch(client, /CodeModeEnvironment|readonly environment:/);
});

test("runtime contract tests exercise only the public contract surface", async () => {
  const contractTest = await readFile(
    new URL("./testing/index.ts", import.meta.url),
    "utf8",
  );

  assert.match(contractTest, /from "\.\.\/index\.ts"/);
  assert.match(contractTest, /testRuntime/);
  assert.match(contractTest, /createRuntime\(\): Promise<Runtime>/);
  assert.match(contractTest, /createClient/);
  assert.match(contractTest, /client\.validate/);
  assert.match(contractTest, /client\.run\(stringifyTestAgentProgram/);
  assert.match(contractTest, /onTelemetry/);
  assert.doesNotMatch(contractTest, /\n {6}program:/);
  assert.doesNotMatch(contractTest, /from "\.\.\/core\//);
  assert.doesNotMatch(contractTest, /ServerUnderTest/);
  assert.doesNotMatch(contractTest, /typeof server/);
  assert.doesNotMatch(contractTest, /"createServer" in/);
  assert.doesNotMatch(contractTest, /startProgram/);
  assert.doesNotMatch(contractTest, /createProgram/);
  assert.doesNotMatch(contractTest, /ByteChannel/);
  assert.doesNotMatch(contractTest, /Symbol\.asyncIterator/);
  assert.doesNotMatch(contractTest, /AsyncIterable/);
  assert.doesNotMatch(contractTest, /byte channel/i);
  assert.doesNotMatch(contractTest, /generated source/i);
});

test("runtime build and validation components do not write generated artifacts to disk", async () => {
  const hostNodeRuntime = await readFile(
    new URL("./host-node/index.ts", import.meta.url),
    "utf8",
  );
  const nodeAdapter = await readFile(
    new URL("./node/index.ts", import.meta.url),
    "utf8",
  );
  const validation = await readFile(
    new URL("./core/validation/index.ts", import.meta.url),
    "utf8",
  );
  const nodeBootstrap = await readFile(
    new URL("./node-runtime/bootstrap.ts", import.meta.url),
    "utf8",
  );
  const runtimeComponents = `${hostNodeRuntime}\n${nodeAdapter}\n${nodeBootstrap}\n${validation}`;

  assert.doesNotMatch(runtimeComponents, /node:fs\/promises/);
  assert.doesNotMatch(runtimeComponents, /\bmkdtemp\b/);
  assert.doesNotMatch(runtimeComponents, /\btmpdir\b/);
  assert.doesNotMatch(runtimeComponents, /\brm\(/);
  assert.doesNotMatch(runtimeComponents, /import .*writeFile/);

  assert.doesNotMatch(hostNodeRuntime, /--eval/);
  assert.match(hostNodeRuntime, /bootstrapWriter/);
  assert.match(nodeBootstrap, /registerHooks/);
  assert.match(nodeBootstrap, /\.code-mode-runtime-payload\.mjs/);
  assert.doesNotMatch(nodeAdapter, /\bspawn\b|node:child_process/);
  assert.match(validation, /new API/);
  assert.match(validation, /createValidationFileSystem/);
});
