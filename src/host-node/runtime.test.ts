import assert from "node:assert/strict";
import test from "node:test";

import { testRuntime } from "../testing/index.ts";
import { createClient, createToolbox } from "../index.ts";
import { HostNodeRuntime } from "./index.ts";
import { readNode24TypeDefinitions } from "./node24.ts";

async function createHostNodeRuntime(): Promise<HostNodeRuntime> {
  return new HostNodeRuntime({ nodePath: process.execPath });
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
    runtime: new HostNodeRuntime({ nodePath: process.execPath }),
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
    }`, {
    signal: AbortSignal.timeout(5_000),
  });

  assert.deepEqual(validation, { kind: "valid" });
});

function assertTypeDefinitionExists(
  files: readonly { readonly path: string }[],
  path: string,
): void {
  assert.ok(files.some((file) => file.path === path), `missing ${path}`);
}
