import assert from "node:assert/strict";
import test from "node:test";

import { runnerSource } from "../runner/source.ts";
import {
  assertNode24Version,
  createNode24BootstrapSource,
  loadNode24TypeDefinitionFiles,
} from "./index.ts";

test("Node 24 declarations include Node and undici package roots", async () => {
  const files = await loadNode24TypeDefinitionFiles(
    AbortSignal.timeout(5_000),
  );

  assert.ok(files.some(
    (file) => file.path === "node_modules/@types/node/index.d.ts",
  ));
  assert.ok(files.some(
    (file) => file.path === "node_modules/undici-types/index.d.ts",
  ));
});

test("Node 24 bootstrap source composes the supplied runner with fd-backed platform glue", () => {
  const source = createNode24BootstrapSource({
    runnerSource,
    channelFileDescriptor: 7,
  });

  assert.match(source, /^export async function startRunner/);
  assert.match(source, /fd: 7,/);
  assert.match(source, /registerHooks/);
  assert.match(source, /await startRunner/);
  assert.doesNotMatch(source, /from "\.\.?\//);
});

test("Node 24 bootstrap source requires a runner and valid file descriptor", () => {
  assert.throws(
    () => createNode24BootstrapSource({
      runnerSource: "",
      channelFileDescriptor: 3,
    }),
    /runner source must not be empty/,
  );
  assert.throws(
    () => createNode24BootstrapSource({
      runnerSource,
      channelFileDescriptor: -1,
    }),
    /file descriptor must be a non-negative safe integer/,
  );
});

test("Node 24 version assertion rejects other major versions", () => {
  assert.doesNotThrow(() => assertNode24Version("v24.12.0", "Test runtime"));
  assert.throws(
    () => assertNode24Version("v25.0.0", "Test runtime"),
    /Test runtime requires Node\.js 24, but reported v25\.0\.0/,
  );
});
