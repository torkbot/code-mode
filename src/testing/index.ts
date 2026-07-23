import assert from "node:assert/strict";
import test from "node:test";

import type {
  Runtime,
  TelemetryEvent,
} from "../index.ts";
import { createClient, createToolbox, defineTool } from "../index.ts";
import type { RuntimeProgramOutput } from "../runtime/index.ts";
import { testSchema } from "./schema.ts";

/** Inputs used to register the reusable Runtime conformance suite. */
export interface RuntimeConformanceOptions {
  /** Human-readable adapter name prefixed to every generated test. */
  readonly name: string;
  /**
   * Create a fresh arbitrary Runtime for one test. The signal governs boot; the
   * suite disposes the returned Runtime after each black-box assertion.
   */
  createRuntime(signal: AbortSignal): Promise<Runtime>;
}

/**
 * Register black-box tests for both the direct Runtime interface and the public
 * Client journey over that Runtime. No driver or wire internals are observed.
 *
 * @param options Adapter name and fresh Runtime factory used by each test.
 */
export function testRuntime(options: RuntimeConformanceOptions): void {
  test(`${options.name}: runtime executes default-export modules with tools and text output`, async () => {
    await withRuntime(options, async (runtime) => {
      const outputs: RuntimeProgramOutput[] = [];
      const outcome = await runtime.execute({
        source: [
          "export default async function ({ codemode, console }) {",
          "  console.log('before');",
          "  const value = await codemode.echo({ value: 'hello' });",
          "  console.error(value.value);",
          "  return 42;",
          "}",
        ].join("\n"),
        signal: AbortSignal.timeout(5_000),
        async invokeTool(request) {
          assert.equal(request.name, "echo");
          assert.deepEqual(request.input, { value: "hello" });
          assert.equal(request.signal.aborted, false);
          return request.input;
        },
        emitOutput(output) {
          outputs.push(output);
        },
      });

      assert.deepEqual(outcome, { kind: "success" });
      assert.deepEqual(outputs.map((output) => output.stream), [
        "stdout",
        "stderr",
      ]);
      assert.match(outputs[0]?.text ?? "", /before/);
      assert.match(outputs[1]?.text ?? "", /hello/);
    });
  });

  test(`${options.name}: runtime rejects missing default callables as program failures`, async () => {
    await withRuntime(options, async (runtime) => {
      const missing = await runtime.execute({
        source: "export const value = 42;",
        signal: AbortSignal.timeout(5_000),
        async invokeTool() {
          throw new Error("program must not invoke tools");
        },
        emitOutput() {},
      });
      assert.equal(missing.kind, "program-failed");
      assert.match(missing.error.message, /default-export a function/);

      const failed = await runtime.execute({
        source: `export default function () { throw new Error("program failed"); }`,
        signal: AbortSignal.timeout(5_000),
        async invokeTool() {
          throw new Error("program must not invoke tools");
        },
        emitOutput() {},
      });
      assert.equal(failed.kind, "program-failed");
      assert.equal(failed.error.message, "program failed");

      const ignoredResult = await runtime.execute({
        source: "export default function () { return 42; }",
        signal: AbortSignal.timeout(5_000),
        async invokeTool() {
          throw new Error("program must not invoke tools");
        },
        emitOutput() {},
      });
      assert.deepEqual(ignoredResult, { kind: "success" });
    });
  });

  test(`${options.name}: runtime cancellation is execution-local`, async () => {
    await withRuntime(options, async (runtime) => {
      const started = Promise.withResolvers<void>();
      const controller = new AbortController();
      const reason = new Error("execution cancelled");
      const execution = runtime.execute({
        source: [
          "export default async function ({ codemode }) {",
          "  await codemode.block({});",
          "}",
        ].join("\n"),
        signal: controller.signal,
        async invokeTool(request) {
          started.resolve();
          await new Promise<never>((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            );
          });
        },
        emitOutput() {},
      });

      await started.promise;
      controller.abort(reason);
      await assert.rejects(execution, (error) => error === reason);

      assert.deepEqual(await runtime.execute({
        source: "export default function () {}",
        signal: AbortSignal.timeout(5_000),
        async invokeTool() {
          throw new Error("program must not invoke tools");
        },
        emitOutput() {},
      }), { kind: "success" });
    });
  });

  test(`${options.name}: each execution evaluates a fresh root module`, async () => {
    await withRuntime(options, async (runtime) => {
      const source = [
        "let calls = 0;",
        "export default function ({ console }) {",
        "  console.log(String(++calls));",
        "}",
      ].join("\n");
      const run = async (): Promise<string> => {
        let text = "";
        const outcome = await runtime.execute({
          source,
          signal: AbortSignal.timeout(5_000),
          async invokeTool() {
            throw new Error("program must not invoke tools");
          },
          emitOutput(output) {
            text += output.text;
          },
        });
        assert.deepEqual(outcome, { kind: "success" });
        return text;
      };

      assert.match(await run(), /1/);
      assert.match(await run(), /1/);
    });
  });

  test(`${options.name}: client validates and executes an ESM agent journey`, async () => {
    await withRuntime(options, async (runtime) => {
      const executions: unknown[] = [];
      const toolbox = createToolbox([
        defineTool(
          "label",
          {
            description: "Label a value.",
            inputSchema: LabelInput,
            outputSchema: LabelOutput,
          },
          async (_ctx, input) => {
            executions.push(input);
            return { label: input.value };
          },
        ),
      ]);
      const client = createClient({ runtime, toolbox });

      const invalid = await client.validate([
        "export default async function ({ codemode }: AgentProgramScope) {",
        "  await codemode.label({ value: 42 });",
        "}",
      ].join("\n"), AbortSignal.timeout(5_000));
      assert.equal(invalid.kind, "invalid");
      assert.equal(executions.length, 0);

      const source = [
        "export default async function ({ codemode, console }: AgentProgramScope) {",
        '  const result = await codemode.label({ value: "journey" });',
        "  console.log(result.label);",
        "}",
      ].join("\n");
      assert.deepEqual(
        await client.validate(source, AbortSignal.timeout(5_000)),
        { kind: "valid" },
      );

      const telemetry: TelemetryEvent[] = [];
      assert.deepEqual(await client.run(source, {
        signal: AbortSignal.timeout(5_000),
        onTelemetry(event) {
          telemetry.push(event);
        },
      }), { kind: "success" });
      assert.deepEqual(executions, [{ value: "journey" }]);
      assert.deepEqual(telemetry.map((event) => event.kind), [
        "tool-call-started",
        "tool-call-completed",
        "program-output",
        "execution-completed",
      ]);
      const output = telemetry.find((event) => event.kind === "program-output");
      assert.equal(output?.stream, "stdout");
      assert.match(output?.text ?? "", /journey/);
    });
  });

  test(`${options.name}: client validates tool values on both sides`, async () => {
    await withRuntime(options, async (runtime) => {
      const invalidInputClient = createClient({
        runtime,
        toolbox: createToolbox([
          defineTool(
            "label",
            {
              description: "Label a value.",
              inputSchema: LabelInput,
              outputSchema: LabelOutput,
            },
            async (_ctx, input) => ({ label: input.value }),
          ),
        ]),
      });
      const invalidInput = await invalidInputClient.run([
        "export default async function ({ codemode }) {",
        "  await codemode.label({ value: 42 });",
        "}",
      ].join("\n"), { signal: AbortSignal.timeout(5_000) });
      assert.equal(invalidInput.kind, "program-failed");
      assert.equal(invalidInput.error.name, "ToolValidationError");
      assert.match(invalidInput.error.details?.report ?? "", /input validation failed/);

      const invalidOutputClient = createClient({
        runtime,
        toolbox: createToolbox([
          defineTool(
            "label",
            {
              description: "Label a value.",
              inputSchema: LabelInput,
              outputSchema: LabelOutput,
            },
            async () => ({} as never),
          ),
        ]),
      });
      const invalidOutput = await invalidOutputClient.run([
        "export default async function ({ codemode }) {",
        '  await codemode.label({ value: "ok" });',
        "}",
      ].join("\n"), { signal: AbortSignal.timeout(5_000) });
      assert.equal(invalidOutput.kind, "program-failed");
      assert.equal(invalidOutput.error.name, "ToolValidationError");
      assert.match(invalidOutput.error.details?.report ?? "", /output validation failed/);
    });
  });
}

const LabelInput = testSchema({
  type: "object",
  properties: {
    value: { type: "string" },
  },
  required: ["value"],
  additionalProperties: false,
} as const);

const LabelOutput = testSchema({
  type: "object",
  properties: {
    label: { type: "string" },
  },
  required: ["label"],
  additionalProperties: false,
} as const);

async function withRuntime<T>(
  options: RuntimeConformanceOptions,
  run: (runtime: Runtime) => Promise<T>,
): Promise<T> {
  const runtime = await options.createRuntime(AbortSignal.timeout(5_000));
  try {
    return await run(runtime);
  } finally {
    await runtime[Symbol.asyncDispose]();
    assert.deepEqual(await runtime.finished, { kind: "closed" });
  }
}
