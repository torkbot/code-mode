import assert from "node:assert/strict";
import test from "node:test";

import { createClient } from "./client.ts";
import type {
  RunOutcome,
  Runtime,
  RuntimeExecuteRequest,
} from "./runtime.ts";
import type { TelemetryEvent } from "./telemetry.ts";
import { createToolbox, defineTool } from "./types.ts";
import { testSchema } from "../testing/schema.ts";

const EmptyObject = testSchema({
  type: "object",
  properties: {},
  additionalProperties: false,
} as const);

test("validation does not load runtime types after cancellation", async () => {
  const reason = new Error("validation cancelled before type loading");
  const controller = new AbortController();
  let loaded = false;
  const runtime = createTestRuntime({
    async loadTypeDefinitionFiles() {
      loaded = true;
      throw new Error("type definitions should not be loaded");
    },
  });
  const client = createClient({ runtime, toolbox: createToolbox([]) });

  controller.abort(reason);

  await assert.rejects(
    client.validate("export default function () {}", controller.signal),
    (error) => error === reason,
  );
  assert.equal(loaded, false);
});

test("validation does not wait for runtime types after cancellation", async () => {
  const reason = new Error("validation cancelled during type loading");
  const controller = new AbortController();
  const loadingStarted = Promise.withResolvers<void>();
  let runtimeSignal: AbortSignal | undefined;
  const runtime = createTestRuntime({
    async loadTypeDefinitionFiles(signal) {
      runtimeSignal = signal;
      loadingStarted.resolve();
      return await new Promise<never>(() => {});
    },
  });
  const client = createClient({ runtime, toolbox: createToolbox([]) });

  const validation = client.validate(
    "export default function () {}",
    controller.signal,
  );
  await loadingStarted.promise;
  assert.equal(runtimeSignal, controller.signal);
  controller.abort(reason);

  await assert.rejects(validation, (error) => error === reason);
});

test("client runs ESM without shifting source locations and emits text program output", async () => {
  let runtimeRequest: RuntimeExecuteRequest | undefined;
  const runtime = createTestRuntime({
    async execute(request) {
      runtimeRequest = request;
      request.emitOutput({ stream: "stdout", text: "echoed\n" });
      await request.invokeTool({
        name: "echo",
        input: {},
        signal: request.signal,
      });
      return { kind: "success" };
    },
  });
  const toolbox = createToolbox([
    defineTool(
      "echo",
      {
        description: "Echo an empty object.",
        inputSchema: EmptyObject,
        outputSchema: EmptyObject,
      },
      async () => ({}),
    ),
  ]);
  const client = createClient({ runtime, toolbox });
  const events: TelemetryEvent[] = [];
  const source = [
    'import { join } from "node:path";',
    "",
    "export default async function ({ codemode, console }: AgentProgramScope) {",
    "  console.log(join('a', 'b'));",
    "  await codemode.echo({});",
    "  return 42;",
    "}",
  ].join("\n");

  const outcome = await client.run(source, {
    signal: AbortSignal.timeout(5_000),
    onTelemetry(event) {
      events.push(event);
    },
  });

  assert.deepEqual(outcome, { kind: "success" });
  assert.equal(runtimeRequest?.source.split("\n").length, source.split("\n").length);
  assert.match(runtimeRequest?.source ?? "", /^import \{ join \}/);
  assert.match(runtimeRequest?.source ?? "", /export default async function/);
  assert.doesNotMatch(runtimeRequest?.source ?? "", /AgentProgramScope/);
  assert.doesNotMatch(runtimeRequest?.source ?? "", /startProgram|createProgram/);
  assert.deepEqual(events.map((event) => event.kind), [
    "program-output",
    "tool-call-started",
    "tool-call-completed",
    "execution-completed",
  ]);
  assert.deepEqual(events[0], {
    kind: "program-output",
    stream: "stdout",
    text: "echoed\n",
  });
});

function createTestRuntime(
  overrides: Partial<Pick<Runtime, "execute" | "loadTypeDefinitionFiles">>,
): Runtime {
  return {
    description: "Test JavaScript runtime",
    finished: Promise.resolve({ kind: "closed" }),
    async loadTypeDefinitionFiles() {
      return [];
    },
    async execute(): Promise<RunOutcome> {
      return { kind: "success" };
    },
    async [Symbol.asyncDispose]() {},
    ...overrides,
  };
}
