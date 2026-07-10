import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentProgram,
  TelemetryEvent,
  Runtime,
} from "../index.ts";
import { createClient, createToolbox, defineTool } from "../index.ts";
import { testSchema, testTransformSchema } from "./schema.ts";

export type RuntimeFactory =
  () => Promise<Runtime>;

export interface RuntimeTestOptions {
  readonly name: string;
  readonly createRuntime: RuntimeFactory;
}

export function testRuntime(options: RuntimeTestOptions): void {
  test(`${options.name}: agent journey reads declarations, checks, and runs without checking side effects`, async () => {
    const runtime = await options.createRuntime();
    let executions = 0;
    const toolbox = createToolbox([
      defineTool(
        "label",
        {
          description: "Label a supplied value.",
          inputSchema: LabelInput,
          outputSchema: LabelOutput,
        },
        async (_ctx, input) => {
          executions++;
          return { source: input.value };
        },
      ),
    ]);
    const client = createClient({ runtime, toolbox, environment: testEnvironment });

    assert.match(toolbox.typeDefinitions, /label\(input:/);
    assert.match(
      toolbox.typeDefinitions,
      /type AgentProgram/,
    );

    const invalid = await client.validate(
      "async ({ codemode }) => { await codemode.label({ value: 42 }); }",
      { signal: AbortSignal.timeout(5_000) },
    );
    assert.equal(invalid.kind, "invalid");
    assert.equal(executions, 0);

    const source = `async ({ codemode }: AgentProgramScope) => {
      const result: { readonly source: string } = await codemode.label({ value: "journey" });
      if (result.source !== "journey") throw new Error("unexpected label");
    }`;
    assert.deepEqual(
      await client.validate(source, { signal: AbortSignal.timeout(5_000) }),
      { kind: "valid" },
    );
    assert.equal(executions, 0);
    assert.deepEqual(
      await client.run(source, { signal: AbortSignal.timeout(5_000) }).result,
      { kind: "success" },
    );
    assert.equal(executions, 1);
  });

  test(`${options.name}: checking reports syntax, unknown tools, bounded diagnostics, and cancellation`, async () => {
    const runtime = await options.createRuntime();
    const client = createClient({
      runtime,
      toolbox: weatherAlertToolbox,
      environment: testEnvironment,
    });

    const syntax = await client.validate("async ({", {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(syntax.kind, "invalid");
    assert.match(syntax.report, /TS\d+/);

    const unknown = await client.validate(
      "async ({ codemode }) => { await codemode.notRegistered({}); }",
      { signal: AbortSignal.timeout(5_000) },
    );
    assert.equal(unknown.kind, "invalid");
    assert.match(unknown.report, /notRegistered/);

    const manyErrors = await client.validate(`async ({ codemode }) => {
      ${Array.from({ length: 20 }, (_, index) => (
        `await codemode.getWeather({ location: ${index} });`
      )).join("\n")}
    }`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(manyErrors.kind, "invalid");
    assert.ok(manyErrors.diagnostics.length <= 8);
    assert.ok(manyErrors.report.length <= 8_000);
    assert.deepEqual(JSON.parse(JSON.stringify(manyErrors)), manyErrors);

    const controller = new AbortController();
    controller.abort(new Error("cancel checking"));
    await assert.rejects(
      client.validate("async () => {}", { signal: controller.signal }),
      /cancel checking|aborted/i,
    );
  });

  test(`${options.name}: execution transpiles erasable TypeScript and preserves schema transformations`, async () => {
    const runtime = await options.createRuntime();
    const observedInputs: unknown[] = [];
    const toolbox = createTransformToolbox(observedInputs);
    const client = createClient({
      runtime,
      toolbox,
      environment: testEnvironment,
    });
    const telemetry = createTelemetryRecorder();
    const source = `async ({ codemode }: AgentProgramScope) => {
      const output: { readonly formatted: string } = await codemode.transform({ value: "41" });
      if (output.formatted !== "42") throw new Error("transform failed");
    }`;
    assert.match(
      toolbox.typeDefinitions,
      /transform\(input: \{[\s\S]*value: string[\s\S]*Promise<\{[\s\S]*formatted: string/,
    );

    assert.deepEqual(
      await client.validate(source, { signal: AbortSignal.timeout(5_000) }),
      { kind: "valid" },
    );
    const outcome = await client.run(source, {
      signal: AbortSignal.timeout(5_000),
      onTelemetry: telemetry.onTelemetry,
    }).result;
    assert.deepEqual(outcome, { kind: "success" });
    assert.deepEqual(observedInputs, [{ value: 41 }]);

    const started = telemetry.events.find((event) => event.kind === "tool-call-started");
    const completed = telemetry.events.find((event) => event.kind === "tool-call-completed");
    assert.deepEqual(started?.input, { value: "41" });
    assert.deepEqual(completed?.output, { formatted: "42" });
  });

  test(`${options.name}: execution resolves syntax, non-void, unknown-tool, and tool failures as program outcomes`, async () => {
    const runtime = await options.createRuntime();
    const emptyClient = createClient({
      runtime,
      toolbox: createToolbox([]),
      environment: testEnvironment,
    });

    const syntax = await emptyClient.run("async ({", {
      signal: AbortSignal.timeout(5_000),
    }).result;
    assert.equal(syntax.kind, "program-failed");
    assert.equal(syntax.error.name, "SyntaxError");
    assert.match(syntax.error.message, /InvalidSyntax/);

    const nonVoid = await emptyClient.run("async () => 42", {
      signal: AbortSignal.timeout(5_000),
    }).result;
    assert.equal(nonVoid.kind, "program-failed");
    assert.match(nonVoid.error.message, /must resolve to undefined/);

    const unknown = await emptyClient.run(
      "async ({ codemode }) => { await codemode.notRegistered({}); }",
      { signal: AbortSignal.timeout(5_000) },
    ).result;
    assert.equal(unknown.kind, "program-failed");
    assert.match(unknown.error.message, /No code-mode tool is registered/);

    const failingClient = createClient({
      runtime,
      toolbox: createFailingToolbox(),
      environment: testEnvironment,
    });
    const toolFailure = await failingClient.run(
      "async ({ codemode }) => { await codemode.fail({}); }",
      { signal: AbortSignal.timeout(5_000) },
    ).result;
    assert.equal(toolFailure.kind, "program-failed");
    assert.equal(toolFailure.error.message, "tool contract failure");
  });

  test(`${options.name}: telemetry is ordered and callback failures cannot alter execution`, async () => {
    const runtime = await options.createRuntime();
    const client = createClient({
      runtime,
      toolbox: createLabelToolbox("telemetry"),
      environment: testEnvironment,
    });
    const events: TelemetryEvent[] = [];
    const outcome = await client.run(stringifyTestAgentProgram(labelAgentProgram), {
      signal: AbortSignal.timeout(5_000),
      onTelemetry(event) {
        events.push(event);
        throw new Error("telemetry consumer failed");
      },
    }).result;

    assert.deepEqual(outcome, { kind: "success" });
    assert.deepEqual(events.map((event) => event.sequence),
      events.map((_event, index) => index));
    assert.deepEqual(events.map((event) => event.kind), [
      "execution-started",
      "runtime-started",
      "program-started",
      "tool-call-started",
      "tool-call-completed",
      "runtime-finished",
      "execution-completed",
    ]);
    assert.ok(events.every((event) => !Number.isNaN(Date.parse(event.timestamp))));
  });

  test(`${options.name}: aborts reject execution and do not poison later executions`, async () => {
    const runtime = await options.createRuntime();
    const controller = new AbortController();
    controller.abort(new Error("cancel before start"));
    const client = createClient({
      runtime,
      toolbox: createToolbox([]),
      environment: testEnvironment,
    });
    await assert.rejects(
      client.run("async () => {}", { signal: controller.signal }).result,
    );

    const blocking = createBlockingToolbox();
    const blockingClient = createClient({
      runtime,
      toolbox: blocking.toolbox,
      environment: testEnvironment,
    });
    const during = new AbortController();
    const execution = blockingClient.run(
      "async ({ codemode }) => { await codemode.block({}); }",
      { signal: during.signal },
    );
    await blocking.started;
    during.abort(new Error("cancel during execution"));
    await assert.rejects(execution.result);

    assert.deepEqual(
      await client.run("async () => {}", {
        signal: AbortSignal.timeout(5_000),
      }).result,
      { kind: "success" },
    );
  });

  test(`${options.name}: one client supports isolated concurrent executions`, async () => {
    const runtime = await options.createRuntime();
    const client = createClient({
      runtime,
      toolbox: createLabelToolbox("shared"),
      environment: testEnvironment,
    });
    const results = await Promise.all([
      client.run(stringifyTestAgentProgram(labelAgentProgram), {
        signal: AbortSignal.timeout(5_000),
      }).result,
      client.run(stringifyTestAgentProgram(labelAgentProgram), {
        signal: AbortSignal.timeout(5_000),
      }).result,
    ]);
    assert.deepEqual(results, [{ kind: "success" }, { kind: "success" }]);
  });

  test(`${options.name}: client runs an agent program against toolbox tools`, async () => {
    const runtime = await options.createRuntime();
    const client = createClient({
      runtime,
      toolbox: weatherAlertToolbox,
      environment: testEnvironment,
    });
    const outcome = await client.run(stringifyTestAgentProgram(weatherAlertAgentProgram), {
      signal: AbortSignal.timeout(5_000),
    }).result;

    assert.deepEqual(outcome, { kind: "success" });
  });

  test(`${options.name}: client resolves a failed outcome when an agent program fails`, async () => {
    const runtime = await options.createRuntime();
    const client = createClient({
      runtime,
      toolbox: createToolbox([]),
      environment: testEnvironment,
    });
    const telemetry = createTelemetryRecorder();
    const execution = client.run(stringifyTestAgentProgram(failureAgentProgram), {
      signal: AbortSignal.timeout(5_000),
      onTelemetry: telemetry.onTelemetry,
    });
    const completedEvent = telemetry.next("execution-completed");

    const outcome = await execution.result;
    assert.equal(outcome.kind, "program-failed");
    assert.equal(outcome.error.name, "Error");
    assert.equal(outcome.error.message, "contract failure");

    const completed = await completedEvent;
    assert.equal(completed.outcome.kind, "program-failed");
    assert.match(completed.outcome.error.message, /contract failure/);
  });

  test(`${options.name}: client validates when an agent program returns a value`, async () => {
    const runtime = await options.createRuntime();
    const client = createClient({
      runtime,
      toolbox: createToolbox([]),
      environment: testEnvironment,
    });

    const validation = await client.validate("async () => 'not void'", {
      signal: AbortSignal.timeout(5_000),
    });

    assert.equal(validation.kind, "invalid");
    assert.match(validation.diagnostics[0]?.message ?? "", /Promise<string>.*Promise<void>/);
    assert.match(validation.report, /Promise<string>.*Promise<void>/);
  });

  test(`${options.name}: client validates bad tool input with serializable diagnostics`, async () => {
    const runtime = await options.createRuntime();
    const client = createClient({
      runtime,
      toolbox: weatherAlertToolbox,
      environment: testEnvironment,
    });

    const validation = await client.validate("async ({ codemode }) => { await codemode.getWeather({ location: 123 }); }", {
      signal: AbortSignal.timeout(5_000),
    });

    assert.equal(validation.kind, "invalid");
    assert.deepEqual(JSON.parse(JSON.stringify(validation)), validation);
    assert.equal(validation.diagnostics[0]?.file, "agent.ts");
    assert.equal(typeof validation.diagnostics[0]?.line, "number");
    assert.equal(typeof validation.diagnostics[0]?.column, "number");
    assert.match(validation.diagnostics[0]?.code ?? "", /^TS/);
    assert.match(validation.diagnostics[0]?.message ?? "", /number.*string/);
    assert.match(validation.report, /codemode\.getWeather/);
    assert.match(validation.report, /location: 123/);
  });

  test(`${options.name}: client.run skips typecheck`, async () => {
    const runtime = await options.createRuntime();
    const client = createClient({
      runtime,
      toolbox: weatherAlertToolbox,
      environment: testEnvironment,
    });

    const outcome = await client.run(`async ({ codemode }) => {
        void codemode.notRegistered;
        await codemode.getWeather({ location: "London" });
      }`, {
      signal: AbortSignal.timeout(5_000),
    }).result;

    assert.deepEqual(outcome, { kind: "success" });
  });

  test(`${options.name}: client.run validates tool input values and formats`, async () => {
    const runtime = await options.createRuntime();
    const client = createClient({
      runtime,
      toolbox: flightSearchToolbox,
      environment: testEnvironment,
    });

    const outcome = await client.run(`async ({ codemode }) => {
        await codemode.listFlights({
          departureDate: "not-a-date",
        });
      }`, {
      signal: AbortSignal.timeout(5_000),
    }).result;

    assert.equal(outcome.kind, "program-failed");
    assert.equal(outcome.error.name, "ToolValidationError");
    assert.match(outcome.error.message, /Tool input validation failed/);
    assert.equal(outcome.error.details?.kind, "tool-validation");
    const report = outcome.error.details?.report ?? "";
    assert.match(report, /Tool input validation failed for listFlights/);
    assert.match(report, /must match format "date"/);
    assert.match(report, /codemode\.listFlights/);
    assert.match(report, /not-a-date/);
    assert.match(report, /Agent call stack:/);
    assert.match(report, /<generated-runtime-program>/);
    assert.ok(
      report.split("\n").every((line) => line.length <= 220),
      "validation report should not contain unbounded stack lines",
    );
  });

  test(`${options.name}: client.run validates tool output values`, async () => {
    const runtime = await options.createRuntime();
    const client = createClient({
      runtime,
      toolbox: invalidFlightOutputToolbox,
      environment: testEnvironment,
    });

    const outcome = await client.run(`async ({ codemode }) => {
        await codemode.listFlights({
          departureDate: "2026-07-01",
        });
      }`, {
      signal: AbortSignal.timeout(5_000),
    }).result;

    assert.equal(outcome.kind, "program-failed");
    assert.equal(outcome.error.name, "ToolValidationError");
    assert.match(outcome.error.message, /Tool output validation failed/);
    assert.equal(outcome.error.details?.kind, "tool-validation");
    const report = outcome.error.details?.report ?? "";
    assert.match(report, /Tool output validation failed for listFlights/);
    assert.match(report, /flights/);
    assert.match(report, /codemode\.listFlights/);
  });

  test(`${options.name}: concurrent clients on one runtime use independent toolboxes`, async () => {
    const runtime = await options.createRuntime();
    const leftClient = createClient({
      runtime,
      toolbox: createLabelToolbox("left"),
      environment: testEnvironment,
    });
    const rightClient = createClient({
      runtime,
      toolbox: createLabelToolbox("right"),
      environment: testEnvironment,
    });

    const outcomes = await Promise.all([
        leftClient.run(stringifyTestAgentProgram(labelAgentProgram), {
          signal: AbortSignal.timeout(5_000),
        }).result,
        rightClient.run(stringifyTestAgentProgram(labelAgentProgram), {
          signal: AbortSignal.timeout(5_000),
        }).result,
      ]);

    assert.deepEqual(outcomes, [{ kind: "success" }, { kind: "success" }]);
  });

  test(`${options.name}: client supports parallel tool calls from one agent program`, async () => {
    const runtime = await options.createRuntime();
    const client = createClient({
      runtime,
      toolbox: createParallelToolbox(),
      environment: testEnvironment,
    });

    assert.deepEqual(
      await client.run(stringifyTestAgentProgram(parallelAgentProgram), {
        signal: AbortSignal.timeout(5_000),
      }).result,
      { kind: "success" },
    );
  });

  test(`${options.name}: client supports interleaved calls to different tools`, async () => {
    const runtime = await options.createRuntime();
    const client = createClient({
      runtime,
      toolbox: createInterleavedToolbox(),
      environment: testEnvironment,
    });

    assert.deepEqual(
      await client.run(stringifyTestAgentProgram(interleavedAgentProgram), {
        signal: AbortSignal.timeout(5_000),
      }).result,
      { kind: "success" },
    );
  });

  test(`${options.name}: client streams typed telemetry before execution completes`, async () => {
    const runtime = await options.createRuntime();
    const telemetryToolbox = createTelemetryToolbox();
    const client = createClient({
      runtime,
      toolbox: telemetryToolbox.toolbox,
      environment: testEnvironment,
    });
    const telemetry = createTelemetryRecorder();

    const execution = client.run(stringifyTestAgentProgram(telemetryAgentProgram), {
      signal: AbortSignal.timeout(5_000),
      onTelemetry: telemetry.onTelemetry,
    });
    let resultSettled = false;
    const result = execution.result.finally(() => {
      resultSettled = true;
    });

    const executionStarted = await telemetry.next("execution-started");
    assert.equal(executionStarted.executionId, execution.id);
    assert.equal(executionStarted.sequence, 0);

    const runtimeStarted = await telemetry.next("runtime-started");
    assert.equal(runtimeStarted.executionId, execution.id);

    const programLog = await telemetry.next("program-log");
    assert.equal(programLog.executionId, execution.id);
    assert.equal(programLog.level, "log");
    assert.match(programLog.message, /^about to wait /);
    assert.equal(programLog.values[0], "about to wait");
    const loggedPayload = programLog.values[1] as {
      readonly label: string;
      readonly self: unknown;
    };
    assert.equal(loggedPayload.label, "gate");
    assert.equal(loggedPayload.self, loggedPayload);
    assert.equal(resultSettled, false);

    const toolStarted = await telemetry.next("tool-call-started");
    assert.equal(toolStarted.executionId, execution.id);
    assert.equal(toolStarted.toolName, "waitForRelease");
    assert.deepEqual(toolStarted.input, { label: "gate" });
    assert.equal(resultSettled, false);

    telemetryToolbox.release();

    const toolCompleted = await telemetry.next("tool-call-completed");
    assert.equal(toolCompleted.executionId, execution.id);
    assert.equal(toolCompleted.toolCallId, toolStarted.toolCallId);
    assert.deepEqual(toolCompleted.output, { released: true });

    assert.deepEqual(await result, { kind: "success" });

    const completed = await telemetry.next("execution-completed");
    assert.equal(completed.executionId, execution.id);
    assert.deepEqual(completed.outcome, { kind: "success" });
  });
}

const testEnvironment = {
  description: "Test JavaScript runtime",
  typeDefinitionFiles: [],
} as const;

interface Weather {
  readonly location: string;
  readonly conditions: string;
  readonly temperature: number;
}

interface WeatherAlertApi {
  getWeather(input: { readonly location: string }): Promise<Weather>;
  sendEmail(input: {
    readonly to: string;
    readonly subject: string;
    readonly body: string;
  }): Promise<{ readonly sent: boolean }>;
}

const GetWeatherInput = testSchema({
  type: "object",
  description: "The weather lookup request.",
  properties: {
    location: {
      type: "string",
      description: "City or place name to look up.",
    },
  },
  required: ["location"],
  additionalProperties: false,
} as const);

const WeatherReport = testSchema({
  type: "object",
  description: "The current weather report.",
  properties: {
    location: {
      type: "string",
      description: "City or place name that was resolved.",
    },
    conditions: {
      type: "string",
      description: "Human-readable weather condition.",
    },
    temperature: {
      type: "number",
      description: "Temperature in degrees Fahrenheit.",
    },
  },
  required: ["location", "conditions", "temperature"],
  additionalProperties: false,
} as const);

const SendEmailInput = testSchema({
  type: "object",
  description: "The email to send.",
  properties: {
    to: {
      type: "string",
      description: "Recipient email address.",
    },
    subject: {
      type: "string",
      description: "Email subject.",
    },
    body: {
      type: "string",
      description: "Email body.",
    },
  },
  required: ["to", "subject", "body"],
  additionalProperties: false,
} as const);

const SendEmailResult = testSchema({
  type: "object",
  description: "The email send result.",
  properties: {
    sent: {
      type: "boolean",
      description: "Whether the email was sent.",
    },
  },
  required: ["sent"],
  additionalProperties: false,
} as const);

const weatherAlertToolbox = createToolbox([
  defineTool(
    "getWeather",
    {
    description: "Get weather for a location.",
    inputSchema: GetWeatherInput,
    outputSchema: WeatherReport,
    },
    async (ctx, input): Promise<Weather> => {
      assert.equal(ctx.signal.aborted, false);
      assert.deepEqual(input, { location: "London" });

      return {
        location: "London",
        conditions: "sunny",
        temperature: 72,
      };
    },
  ),
  defineTool(
    "sendEmail",
    {
    description: "Send an email.",
    inputSchema: SendEmailInput,
    outputSchema: SendEmailResult,
    },
    async (ctx, input): Promise<{ readonly sent: boolean }> => {
      assert.equal(ctx.signal.aborted, false);
      assert.deepEqual(input, {
        to: "team@example.com",
        subject: "Nice day in London",
        body: "Weather in London: 72 and sunny",
      });

      return {
        sent: true,
      };
    },
  ),
]);

const weatherAlertAgentProgram: AgentProgram<WeatherAlertApi> = async ({
  codemode,
}) => {
  const weather = await codemode.getWeather({ location: "London" });

  if (weather.conditions === "sunny") {
    await codemode.sendEmail({
      to: "team@example.com",
      subject: "Nice day in London",
      body: `Weather in ${weather.location}: ${weather.temperature} and ${weather.conditions}`,
    });
  }
};

const failureAgentProgram: AgentProgram<Record<string, never>> = async () => {
  throw new Error("contract failure");
};

interface LabelApi {
  label(input: { readonly value: string }): Promise<{ readonly source: string }>;
}

const FlightSearchInput = testSchema({
  type: "object",
  description: "The flight search request.",
  properties: {
    departureDate: {
      type: "string",
      format: "date",
      description: "Departure date.",
    },
  },
  required: ["departureDate"],
  additionalProperties: false,
} as const);

const FlightSearchOutput = testSchema({
  type: "object",
  description: "The flight search result.",
  properties: {
    flights: {
      type: "array",
      description: "Matching flights.",
      items: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "Flight code.",
          },
        },
        required: ["code"],
        additionalProperties: false,
      },
    },
  },
  required: ["flights"],
  additionalProperties: false,
} as const);

const flightSearchToolbox = createToolbox([
  defineTool(
    "listFlights",
    {
      description: "List flights.",
      inputSchema: FlightSearchInput,
      outputSchema: FlightSearchOutput,
    },
    async (_ctx, input) => {
      assert.deepEqual(input, { departureDate: "2026-07-01" });
      return {
        flights: [{ code: "AC868" }],
      };
    },
  ),
]);

const invalidFlightOutputToolbox = createToolbox([
  defineTool(
    "listFlights",
    {
      description: "List flights.",
      inputSchema: FlightSearchInput,
      outputSchema: FlightSearchOutput,
    },
    async () => {
      return {} as never;
    },
  ),
]);

const LabelInput = testSchema({
  type: "object",
  description: "The label request.",
  properties: {
    value: {
      type: "string",
      description: "Input value.",
    },
  },
  required: ["value"],
  additionalProperties: false,
} as const);

const LabelOutput = testSchema({
  type: "object",
  description: "The label response.",
  properties: {
    source: {
      type: "string",
      description: "The responding toolbox.",
    },
  },
  required: ["source"],
  additionalProperties: false,
} as const);

const EmptyObject = testSchema({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
} as const);

const TransformInput = testTransformSchema<
  { readonly value: string },
  { readonly value: number }
>({
  inputJsonSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  outputJsonSchema: {
    type: "object",
    properties: { value: { type: "number" } },
    required: ["value"],
    additionalProperties: false,
  },
  validate(value) {
    const candidate = value as { readonly value?: unknown };
    if (typeof candidate?.value !== "string" || !Number.isFinite(Number(candidate.value))) {
      return { issues: [{ message: "Expected a numeric string", path: ["value"] }] };
    }
    return { value: { value: Number(candidate.value) } };
  },
});

const TransformOutput = testTransformSchema<
  { readonly value: number },
  { readonly formatted: string }
>({
  inputJsonSchema: {
    type: "object",
    properties: { value: { type: "number" } },
    required: ["value"],
    additionalProperties: false,
  },
  outputJsonSchema: {
    type: "object",
    properties: { formatted: { type: "string" } },
    required: ["formatted"],
    additionalProperties: false,
  },
  validate(value) {
    const candidate = value as { readonly value?: unknown };
    if (typeof candidate?.value !== "number") {
      return { issues: [{ message: "Expected a number", path: ["value"] }] };
    }
    return { value: { formatted: String(candidate.value) } };
  },
});

function createTransformToolbox(observedInputs: unknown[]) {
  return createToolbox([
    defineTool(
      "transform",
      {
        description: "Transform a numeric string.",
        inputSchema: TransformInput,
        outputSchema: TransformOutput,
      },
      async (_ctx, input) => {
        observedInputs.push(input);
        return { value: input.value + 1 };
      },
    ),
  ]);
}

function createFailingToolbox() {
  return createToolbox([
    defineTool(
      "fail",
      {
        description: "Fail a tool call.",
        inputSchema: EmptyObject,
        outputSchema: EmptyObject,
      },
      async () => {
        throw new Error("tool contract failure");
      },
    ),
  ]);
}

function createBlockingToolbox() {
  const started = createDeferred<void>();
  return {
    started: started.promise,
    toolbox: createToolbox([
      defineTool(
        "block",
        {
          description: "Block until execution is aborted.",
          inputSchema: EmptyObject,
          outputSchema: EmptyObject,
        },
        async (ctx) => {
          started.resolve();
          await new Promise<never>((_resolve, reject) => {
            if (ctx.signal.aborted) {
              reject(ctx.signal.reason);
              return;
            }
            ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), {
              once: true,
            });
          });
          return {};
        },
      ),
    ]),
  };
}

function createLabelToolbox(source: string) {
  return createToolbox([
    defineTool(
      "label",
      {
      description: "Return the toolbox label.",
      inputSchema: LabelInput,
      outputSchema: LabelOutput,
      },
      async (ctx, input): Promise<{ readonly source: string }> => {
        assert.equal(ctx.signal.aborted, false);
        assert.deepEqual(input, { value: "request" });

        return { source };
      },
    ),
  ]);
}

const labelAgentProgram: AgentProgram<LabelApi> = async ({
  codemode,
}) => {
  await codemode.label({ value: "request" });
};

interface ParallelApi {
  coordinate(input: { readonly name: string }): Promise<{
    readonly name: string;
    readonly observed: string;
  }>;
}

const CoordinateInput = testSchema({
  type: "object",
  description: "The coordination request.",
  properties: {
    name: {
      type: "string",
      description: "The requested step name.",
    },
  },
  required: ["name"],
  additionalProperties: false,
} as const);

const CoordinateOutput = testSchema({
  type: "object",
  description: "The coordination response.",
  properties: {
    name: {
      type: "string",
      description: "The completed step name.",
    },
    observed: {
      type: "string",
      description: "What the tool observed before returning.",
    },
  },
  required: ["name", "observed"],
  additionalProperties: false,
} as const);

function createParallelToolbox() {
  let resolveSecondStarted: (() => void) | undefined;
  const secondStarted = new Promise<void>((resolve) => {
    resolveSecondStarted = resolve;
  });

  return createToolbox([
    defineTool(
      "coordinate",
      {
      description: "Coordinate parallel tool calls.",
      inputSchema: CoordinateInput,
      outputSchema: CoordinateOutput,
      },
      async (ctx, input): Promise<{ readonly name: string; readonly observed: string }> => {
        assert.equal(ctx.signal.aborted, false);
        assertIsCoordinateInput(input);

        if (input.name === "first") {
          await secondStarted;

          return {
            name: "first",
            observed: "second-started",
          };
        }

        if (input.name === "second") {
          resolveSecondStarted?.();

          return {
            name: "second",
            observed: "started",
          };
        }

        throw new Error(`Unexpected coordinate step: ${input.name}`);
      },
    ),
  ]);
}

const parallelAgentProgram: AgentProgram<ParallelApi> = async ({
  codemode,
}) => {
  await Promise.all([
    codemode.coordinate({ name: "first" }),
    codemode.coordinate({ name: "second" }),
  ]);
};

function assertIsCoordinateInput(
  value: unknown,
): asserts value is { readonly name: string } {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(typeof (value as { readonly name?: unknown }).name, "string");
}

interface InterleavedApi {
  waitForSignal(input: { readonly name: string }): Promise<{ readonly status: string }>;
  signal(input: { readonly name: string }): Promise<{ readonly status: string }>;
}

const SignalInput = testSchema({
  type: "object",
  description: "The signal request.",
  properties: {
    name: {
      type: "string",
      description: "The signal name.",
    },
  },
  required: ["name"],
  additionalProperties: false,
} as const);

const SignalOutput = testSchema({
  type: "object",
  description: "The signal response.",
  properties: {
    status: {
      type: "string",
      description: "The signal status.",
    },
  },
  required: ["status"],
  additionalProperties: false,
} as const);

function createInterleavedToolbox() {
  let releaseWaiter: (() => void) | undefined;
  const signalReceived = new Promise<void>((resolve) => {
    releaseWaiter = resolve;
  });

  return createToolbox([
    defineTool(
      "waitForSignal",
      {
      description: "Wait for a signal.",
      inputSchema: SignalInput,
      outputSchema: SignalOutput,
      },
      async (ctx, input): Promise<{ readonly status: string }> => {
        assert.equal(ctx.signal.aborted, false);
        assert.deepEqual(input, { name: "gate" });
        await signalReceived;

        return {
          status: "released",
        };
      },
    ),
    defineTool(
      "signal",
      {
      description: "Send a signal.",
      inputSchema: SignalInput,
      outputSchema: SignalOutput,
      },
      async (ctx, input): Promise<{ readonly status: string }> => {
        assert.equal(ctx.signal.aborted, false);
        assert.deepEqual(input, { name: "gate" });
        releaseWaiter?.();

        return {
          status: "sent",
        };
      },
    ),
  ]);
}

const interleavedAgentProgram: AgentProgram<InterleavedApi> = async ({
  codemode,
}) => {
  await Promise.all([
    codemode.waitForSignal({ name: "gate" }),
    codemode.signal({ name: "gate" }),
  ]);
};

interface TelemetryApi {
  waitForRelease(input: { readonly label: string }): Promise<{ readonly released: boolean }>;
}

const ReleaseInput = testSchema({
  type: "object",
  description: "The release wait request.",
  properties: {
    label: {
      type: "string",
      description: "The release label.",
    },
  },
  required: ["label"],
  additionalProperties: false,
} as const);

const ReleaseOutput = testSchema({
  type: "object",
  description: "The release result.",
  properties: {
    released: {
      type: "boolean",
      description: "Whether the wait was released.",
    },
  },
  required: ["released"],
  additionalProperties: false,
} as const);

function createTelemetryToolbox() {
  const released = createDeferred<void>();

  return {
    toolbox: createToolbox([
      defineTool(
        "waitForRelease",
        {
        description: "Wait until the test releases the tool call.",
        inputSchema: ReleaseInput,
        outputSchema: ReleaseOutput,
        },
        async (ctx, input): Promise<{ readonly released: boolean }> => {
          assert.equal(ctx.signal.aborted, false);
          assert.deepEqual(input, { label: "gate" });
          await released.promise;

          return { released: true };
        },
      ),
    ]),
    release(): void {
      released.resolve();
    },
  };
}

const telemetryAgentProgram: AgentProgram<TelemetryApi> = async ({
  codemode,
}) => {
  const payload = { label: "gate" };
  Object.defineProperty(payload, "self", {
    enumerable: true,
    value: payload,
  });
  console.log("about to wait", payload);
  await codemode.waitForRelease({ label: "gate" });
};

function createTelemetryRecorder() {
  const events: TelemetryEvent[] = [];
  const waiters: TelemetryWaiter<TelemetryEvent["kind"]>[] = [];
  let cursor = 0;

  const next = <TKind extends TelemetryEvent["kind"]>(
    kind: TKind,
  ): Promise<Extract<TelemetryEvent, { readonly kind: TKind }>> => {
    const event = takeNextTelemetryEvent(events, cursor, kind);

    if (event !== undefined) {
      cursor = event.nextCursor;
      return Promise.resolve(
        event.value as Extract<TelemetryEvent, { readonly kind: TKind }>,
      );
    }

    return new Promise((resolve) => {
      waiters.push({
        kind,
        resolve: (value) => {
          resolve(value as Extract<TelemetryEvent, { readonly kind: TKind }>);
        },
      });
    });
  };

  return {
    events,
    onTelemetry(event: TelemetryEvent): void {
      events.push(event);

      for (let index = 0; index < waiters.length; index++) {
        const waiter = waiters[index];

        if (waiter === undefined) {
          continue;
        }

        const event = takeNextTelemetryEvent(events, cursor, waiter.kind);

        if (event === undefined) {
          continue;
        }

        cursor = event.nextCursor;
        waiters.splice(index, 1);
        index--;
        waiter.resolve(event.value);
      }
    },
    next,
  };
}

interface TelemetryWaiter<TKind extends TelemetryEvent["kind"]> {
  readonly kind: TKind;
  resolve(value: Extract<TelemetryEvent, { readonly kind: TKind }>): void;
}

function takeNextTelemetryEvent<TKind extends TelemetryEvent["kind"]>(
  events: readonly TelemetryEvent[],
  cursor: number,
  kind: TKind,
):
  | {
      readonly nextCursor: number;
      readonly value: Extract<TelemetryEvent, { readonly kind: TKind }>;
    }
  | undefined {
  for (let index = cursor; index < events.length; index++) {
    const event = events[index];

    if (event?.kind === kind) {
      return {
        nextCursor: index + 1,
        value: event as Extract<TelemetryEvent, { readonly kind: TKind }>,
      };
    }
  }

  return undefined;
}

function stringifyTestAgentProgram<TApi>(
  program: AgentProgram<TApi>,
): string {
  return program.toString();
}

function createDeferred<TValue>() {
  let resolve!: (value: TValue | PromiseLike<TValue>) => void;
  const promise = new Promise<TValue>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve,
  };
}
