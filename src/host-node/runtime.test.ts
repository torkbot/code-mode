import assert from "node:assert/strict";
import test from "node:test";

import { createClient, createToolbox } from "../index.ts";
import { testRuntime } from "../testing/index.ts";
import { createHostNodeRuntime } from "./index.ts";

const hostOptions = {
  nodePath: process.execPath,
  cwd: process.cwd(),
};

testRuntime({
  name: "host-node runtime",
  createRuntime(signal) {
    return createHostNodeRuntime(hostOptions, signal);
  },
});

test("host-node supplies Node 24 declarations and validates static node imports", async () => {
  const runtime = await createHostNodeRuntime(
    hostOptions,
    AbortSignal.timeout(5_000),
  );
  try {
    const typeDefinitions = await runtime.loadTypeDefinitionFiles(
      AbortSignal.timeout(5_000),
    );
    assert.equal(runtime.description, "Node.js 24");
    assertTypeDefinitionExists(typeDefinitions, "node_modules/@types/node/index.d.ts");
    assertTypeDefinitionExists(typeDefinitions, "node_modules/undici-types/index.d.ts");

    const client = createClient({ runtime, toolbox: createToolbox([]) });
    const validation = await client.validate([
      'import { join } from "node:path";',
      "",
      "export default function ({ console }: AgentProgramScope) {",
      "  console.log(join(process.cwd(), 'value'));",
      "}",
    ].join("\n"), AbortSignal.timeout(5_000));
    assert.deepEqual(validation, { kind: "valid" });
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("host-node resolves static package imports from its configured working directory", async () => {
  const runtime = await createHostNodeRuntime(
    hostOptions,
    AbortSignal.timeout(5_000),
  );
  try {
    const outcome = await runtime.execute({
      source: [
        'import { transformSync } from "amaro";',
        "",
        "export default function () {",
        "  if (typeof transformSync !== 'function') throw new Error('missing amaro');",
        "}",
      ].join("\n"),
      signal: AbortSignal.timeout(5_000),
      async invokeTool() {
        throw new Error("program must not invoke tools");
      },
      emitOutput() {},
    });
    assert.deepEqual(outcome, { kind: "success" });
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("host-node multiplexes executions on one runtime", async () => {
  const runtime = await createHostNodeRuntime(
    hostOptions,
    AbortSignal.timeout(5_000),
  );
  try {
    const started: string[] = [];
    const bothStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const execute = (label: string) => runtime.execute({
      source: [
        "export default async function ({ codemode }) {",
        `  await codemode.wait({ label: ${JSON.stringify(label)} });`,
        "}",
      ].join("\n"),
      signal: AbortSignal.timeout(5_000),
      async invokeTool(request) {
        started.push((request.input as { readonly label: string }).label);
        if (started.length === 2) bothStarted.resolve();
        await release.promise;
        return {};
      },
      emitOutput() {},
    });

    const first = execute("first");
    const second = execute("second");
    await bothStarted.promise;
    assert.deepEqual(new Set(started), new Set(["first", "second"]));
    release.resolve();
    assert.deepEqual(await Promise.all([first, second]), [
      { kind: "success" },
      { kind: "success" },
    ]);
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("host-node captures only the console passed to the default export", async () => {
  const runtime = await createHostNodeRuntime(
    hostOptions,
    AbortSignal.timeout(5_000),
  );
  try {
    let output = "";
    const outcome = await runtime.execute({
      source: [
        'import { log as ambientLog } from "node:console";',
        "",
        "export default function ({ console }) {",
        '  ambientLog("ambient output");',
        '  console.log("captured output");',
        "}",
      ].join("\n"),
      signal: AbortSignal.timeout(5_000),
      async invokeTool() {
        throw new Error("program must not invoke tools");
      },
      emitOutput(chunk) {
        output += chunk.text;
      },
    });

    assert.deepEqual(outcome, { kind: "success" });
    assert.match(output, /captured output/);
    assert.doesNotMatch(output, /ambient output/);
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("host-node keeps agent stack lines aligned with submitted source", async () => {
  const runtime = await createHostNodeRuntime(
    hostOptions,
    AbortSignal.timeout(5_000),
  );
  try {
    const client = createClient({ runtime, toolbox: createToolbox([]) });
    const outcome = await client.run([
      "export default function (",
      "  _scope: AgentProgramScope,",
      ") {",
      "  const first: number = 1;",
      "  void first;",
      "  throw new Error('line sentinel');",
      "}",
    ].join("\n"), {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(outcome.kind, "program-failed");
    const agentFrame = (outcome.error.stack ?? "")
      .split("\n")
      .find((line) => line.includes("code-mode:program")) ?? "";
    assert.match(agentFrame, /code-mode:program\?[\da-f-]+:6:9/);
    assert.doesNotMatch(agentFrame, /execution=/);
    assert.doesNotMatch(agentFrame, new RegExp(process.cwd()));
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("host-node boot cancellation does not govern the connected runtime", async () => {
  const boot = new AbortController();
  const runtime = await createHostNodeRuntime(hostOptions, boot.signal);
  boot.abort(new Error("boot signal ended"));

  try {
    assert.deepEqual(await runtime.execute({
      source: "export default function () {}",
      signal: AbortSignal.timeout(5_000),
      async invokeTool() {
        throw new Error("program must not invoke tools");
      },
      emitOutput() {},
    }), { kind: "success" });
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("host-node rejects binaries outside Node 24 during boot", async () => {
  await assert.rejects(
    createHostNodeRuntime(
      { nodePath: "/bin/echo", cwd: process.cwd() },
      AbortSignal.timeout(5_000),
    ),
    /requires Node\.js 24/,
  );
});

function assertTypeDefinitionExists(
  files: readonly { readonly path: string }[],
  path: string,
): void {
  assert.ok(files.some((file) => file.path === path), `missing ${path}`);
}
