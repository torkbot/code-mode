import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeInstance } from "../core/runtime.ts";
import {
  Node24Runtime,
  type Node24RuntimeHost,
  type Node24RuntimeLaunchRequest,
} from "./index.ts";

test("node adapter turns a runtime payload into a caller-launched Node entrypoint", async () => {
  const signal = AbortSignal.timeout(5_000);
  const expectedInstance = createClosedRuntimeInstance();
  let versionReads = 0;
  let launchRequest: Node24RuntimeLaunchRequest | undefined;
  const host: Node24RuntimeHost = {
    async readNodeVersion(observedSignal) {
      assert.equal(observedSignal, signal);
      versionReads++;
      return "v24.12.0";
    },
    async launchNode(req) {
      launchRequest = req;
      return expectedInstance;
    },
  };
  const runtime = new Node24Runtime(host);

  const typeDefinitions = await runtime.loadTypeDefinitionFiles(signal);
  const instance = await runtime.start({
    payload: {
      kind: "javascript-module",
      source: `export async function startProgram(channel) {
        const writer = channel.writable.getWriter();
        await writer.write(new TextEncoder().encode("payload sentinel"));
        await writer.close();
      }`,
    },
    signal,
  });

  assert.equal(runtime.description, "Node.js 24");
  assert.equal(versionReads, 1);
  assert.ok(
    typeDefinitions.some((file) => (
      file.path === "node_modules/@types/node/index.d.ts"
    )),
  );
  assert.equal(instance, expectedInstance);
  assert.equal(launchRequest?.signal, signal);
  assert.equal(launchRequest?.channelFileDescriptor, 3);
  assert.match(launchRequest?.bootstrapSource ?? "", /const channelFd = 3/);
  assert.match(launchRequest?.bootstrapSource ?? "", /payload sentinel/);
  assert.match(launchRequest?.bootstrapSource ?? "", /await start\(\{/);
  assert.match(
    launchRequest?.bootstrapSource ?? "",
    /resolve\(process\.cwd\(\), "\.code-mode-runtime-payload\.mjs"\)/,
  );
  assert.doesNotMatch(launchRequest?.bootstrapSource ?? "", /node:child_process/);
  assert.doesNotMatch(launchRequest?.bootstrapSource ?? "", /Sandbox/);
});

test("node adapter rejects a non-Node-24 target before launch", async () => {
  let launched = false;
  const runtime = new Node24Runtime({
    async readNodeVersion() {
      return "v23.11.0";
    },
    async launchNode() {
      launched = true;
      return createClosedRuntimeInstance();
    },
  });

  await assert.rejects(runtime.start({
    payload: {
      kind: "javascript-module",
      source: "export async function startProgram() {}",
    },
    signal: AbortSignal.timeout(5_000),
  }), /requires Node\.js 24/);
  assert.equal(launched, false);
});

function createClosedRuntimeInstance(): RuntimeInstance {
  const channel: RuntimeInstance["channel"] = {
    readable: new ReadableStream({ start(controller) { controller.close(); } }),
    writable: new WritableStream(),
  };

  return {
    channel,
    finished: Promise.resolve({ kind: "closed" }),
    async terminate() {},
  };
}
