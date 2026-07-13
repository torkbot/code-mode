import assert from "node:assert/strict";
import test from "node:test";

import { createClient } from "./client.ts";
import type { Runtime } from "./runtime.ts";
import { createToolbox } from "./types.ts";

test("validation does not load runtime types after cancellation", async () => {
  const reason = new Error("validation cancelled before type loading");
  const controller = new AbortController();
  let loaded = false;
  const runtime = createTestRuntime(async () => {
    loaded = true;
    throw new Error("type definitions should not be loaded");
  });
  const client = createClient({ runtime, toolbox: createToolbox([]) });

  controller.abort(reason);

  await assert.rejects(
    client.validate("async () => {}", controller.signal),
    (error) => error === reason,
  );
  assert.equal(loaded, false);
});

test("validation honors cancellation that occurs while runtime types load", async () => {
  const reason = new Error("validation cancelled during type loading");
  const controller = new AbortController();
  const runtime = createTestRuntime(async () => {
    controller.abort(reason);
    return [];
  });
  const client = createClient({ runtime, toolbox: createToolbox([]) });

  await assert.rejects(
    client.validate("async () => {}", controller.signal),
    (error) => error === reason,
  );
});

function createTestRuntime(
  loadTypeDefinitionFiles: Runtime["loadTypeDefinitionFiles"],
): Runtime {
  return {
    description: "Test JavaScript runtime",
    loadTypeDefinitionFiles,
    async start() {
      throw new Error("test runtime must not start");
    },
  };
}
