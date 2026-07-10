# @torkbot/code-mode

Run agent-authored TypeScript against host-controlled tools on a pluggable
JavaScript runtime.

The library owns generated declarations, checking, TypeScript
erasure, host-side validation, routing, and telemetry. A runtime adapter only
evaluates a self-contained JavaScript module and provides a bidirectional byte
channel.

## Install

```sh
npm install @torkbot/code-mode
```

The host library requires Node.js 24 or newer. The first execution adapters are
host Node.js and Node.js inside `@torkbot/sandbox`.

## Quick Start

```ts
import {
  createClient,
  createToolbox,
  defineTool,
} from "@torkbot/code-mode";
import { HostNodeRuntime } from "@torkbot/code-mode/host-node";
import { readNode24TypeDefinitions } from "@torkbot/code-mode/host-node/node24";

const toolbox = createToolbox([
  defineTool(
    "getWeather",
    {
      description: "Get weather for a location.",
      inputSchema: WeatherInput,
      outputSchema: WeatherReport,
    },
    async (ctx, input) => {
      ctx.signal.throwIfAborted();
      return weatherService.get(input.location);
    },
  ),
]);

const environment = {
  description: `Node.js ${process.version}`,
  typeDefinitionFiles: await readNode24TypeDefinitions(),
};

const client = createClient({
  toolbox,
  runtime: new HostNodeRuntime({ nodePath: process.execPath }),
  environment,
});

const declarations = toolbox.typeDefinitions;
const runtimeDescription = environment.description;

const source = `async ({ codemode }: AgentProgramScope) => {
  const weather = await codemode.getWeather({ location: "London" });
  console.log(weather.conditions);
}`;

const validation = await client.validate(source, { signal });
if (validation.kind === "invalid") {
  return validation.report;
}

const execution = client.run(source, {
  signal,
  onTelemetry: recordEvent,
});
const outcome = await execution.result;
```

`HostNodeRuntime` is not a sandbox. Use it for trusted programs and integration
tests.

## Tool Schemas

Every input and output schema must implement both
[`StandardSchemaV1`](https://github.com/standard-schema/standard-schema) and
`StandardJSONSchemaV1`:

```ts
type ToolSchema<Input, Output> =
  & StandardSchemaV1<Input, Output>
  & StandardJSONSchemaV1<Input, Output>;
```

Standard Schema validates and transforms values on the host. Standard JSON
Schema produces the input and output JSON Schemas used to synthesize accurate
agent declarations. The library requests draft 2020-12.

Transforming schemas have four distinct type positions:

| Boundary | Type |
| --- | --- |
| Agent supplies tool input | `SchemaInput<InputSchema>` |
| Handler receives validated input | `SchemaOutput<InputSchema>` |
| Handler returns output candidate | `SchemaInput<OutputSchema>` |
| Agent receives validated output | `SchemaOutput<OutputSchema>` |

`defineTool()` preserves those relationships in TypeScript inference. Tool names
must be unique JavaScript identifiers, and descriptions must be non-empty because
they document the generated declarations.

The generated declaration printer currently supports object, array, string,
number, integer, boolean, and null JSON Schemas. Object properties and required
keys are preserved, and object schemas must explicitly set
`additionalProperties: false`. Descriptions become JSDoc and string formats
become `@format` tags. A schema that cannot be represented honestly is rejected
during type generation. The declarations also define the five runtime-supported
console methods, so logging checks consistently across environments.

## Agent API

```ts
interface Client {
  validate(
    source: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ValidationResult>;

  run(
    source: string,
    options?: {
      readonly signal?: AbortSignal;
      readonly onTelemetry?: TelemetryCallback;
    },
  ): ClientExecution;
}
```

The intended model-facing sequence is:

1. Read `toolbox.typeDefinitions` and `environment.description`.
2. Author one async function expression returning `Promise<void>`.
3. Call `validate()` and repair any diagnostics.
4. Call `run()`.

`toolbox.typeDefinitions` contains the program contract and the complete
toolbox. It is deterministic and has no runtime side effects. The environment
description is separate concise context for the agent.

`validate()` uses the released native TypeScript compiler with an in-memory
project. It mounts the toolbox declarations as `codemode.d.ts` and the
environment's `typeDefinitionFiles` at their supplied virtual paths. Runtime
type files are checker-only; they are not included in agent declarations or sent
to the execution runtime.
Validation enforces the same erasable-only TypeScript subset that execution can
strip. Diagnostics use submitted-source positions; diagnostics and reports are
serializable and bounded.

`run()` does not typecheck. It strips erasable TypeScript syntax in memory, then
executes JavaScript. Syntax unsupported by erasable-only TypeScript is a program
failure. Tool inputs and outputs are always validated on the host, even when the
agent skips checking.

## Outcomes

```ts
interface ClientExecution {
  readonly id: string;
  readonly result: Promise<RunOutcome>;
}

type RunOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "program-failed"; readonly error: TelemetryError };
```

Syntax errors, runtime errors, non-void returns, unknown tool calls, handler
errors, and input/output validation errors resolve as `program-failed` outcomes.
Broken runtime transport and violated library invariants reject
`execution.result`. Aborting an execution rejects it after the runtime is
terminated.

Validation failures include a bounded source-framed report. Runtime tool
validation failures also expose a report through
`outcome.error.details.kind === "tool-validation"`.

## Telemetry

Every event has an execution id, monotonic sequence, and timestamp. Events cover
execution/runtime/program start, console logs, tool start/completion/failure,
runtime finish, and terminal execution completion/failure.

```ts
const execution = client.run(source, {
  onTelemetry(event) {
    if (event.kind === "tool-call-started") {
      console.log(event.toolName, event.input);
    }
  },
});
```

Console values are decoded before callback delivery and preserve circular object
references. Exceptions thrown by telemetry callbacks are isolated from program
execution.

## Runtime Contract

Runtime authors import contracts from `@torkbot/code-mode/runtime`:

```ts
interface Runtime {
  start(request: {
    readonly program: {
      readonly kind: "javascript-module";
      readonly source: string;
    };
    readonly signal: AbortSignal;
  }): Promise<RuntimeInstance>;
}

interface RuntimeInstance {
  readonly channel: ByteChannel;
  readonly finished: Promise<
    | { readonly kind: "closed" }
    | { readonly kind: "failed"; readonly error: Error }
  >;
  terminate(reason: string): Promise<void>;
}

interface ByteChannel {
  readonly incoming: AsyncIterable<Uint8Array>;
  readonly outgoing: {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
  };
}
```

The program is self-contained ESM and exports:

```ts
export function startProgram(channel: ByteChannel): Promise<void>;
```

The adapter evaluates the module, invokes `startProgram(channel)`, and reports
lifecycle completion. It does not receive tool definitions, decode protocol
messages, inject globals, or write generated files unless its own substrate
requires that as an implementation detail.

## Node Adapters

### Host Node.js

```ts
const runtime = new HostNodeRuntime({ nodePath: process.execPath });
```

The required path is used to spawn a child Node.js process. The generated module
is evaluated from an in-memory URL and the byte channel uses fd 3.

### Sandbox Node.js

```ts
import { SandboxNodeRuntime } from "@torkbot/code-mode/sandbox-node";

const runtime = new SandboxNodeRuntime({
  sandbox,
  nodePath: "/usr/bin/node",
  cwd: "/workspace",
});
```

The sandbox host must support streaming spawn with caller-selected full-duplex
descriptors. The adapter requests fd 3, streams a self-contained bootstrap over
stdin, and uses fd 3 exclusively for code-mode traffic. No generated runtime
file is required in the guest.

## Runtime Conformance

Runtime implementations run the same exported black-box suite:

```ts
import { testRuntime } from "@torkbot/code-mode/testing";

testRuntime({
  name: "my runtime",
  createRuntime: async () => new MyRuntime(),
});
```

The factory is always asynchronous. The suite exercises the public client API
as an agent would: complete declarations, checking, TypeScript
execution, schema transformations, sequential/parallel/interleaved calls,
failures, telemetry, cancellation, concurrency, and execution isolation. It
makes no assumptions about processes, files, descriptors, or the adapter's
internal transport.
