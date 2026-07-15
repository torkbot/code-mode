# @torkbot/code-mode

Run agent-authored TypeScript against host-controlled tools on a pluggable
JavaScript runtime.

The library owns generated declarations, checking, TypeScript erasure,
host-side validation, routing, and telemetry. A runtime adapter describes its
execution environment, supplies its checker declarations, evaluates a
self-contained JavaScript module, and provides a bidirectional byte channel.

## Install

```sh
npm install @torkbot/code-mode
```

The host library requires Node.js 24 or newer. `HostNodeRuntime` is the built-in
execution adapter; other packages can implement the same runtime contract for
isolates, microVMs, remote sandboxes, or other JavaScript targets.

## Quick Start

```ts
import {
  createClient,
  createToolbox,
  defineTool,
} from "@torkbot/code-mode";
import { HostNodeRuntime } from "@torkbot/code-mode/host-node";

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

const runtime = new HostNodeRuntime(process.execPath);

const client = createClient({
  toolbox,
  runtime,
});

const declarations = toolbox.typeDefinitions;
const runtimeDescription = runtime.description;

const source = `async ({ codemode }: AgentProgramScope) => {
  const weather = await codemode.getWeather({ location: "London" });
  console.log(weather.conditions);
}`;

const validation = await client.validate(source, signal);
if (validation.kind === "invalid") {
  return validation.report;
}

const outcome = await client.run(source, {
  signal,
  onTelemetry: recordEvent,
});
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
must be unique JavaScript identifiers other than `then`, which is reserved so the
tool object cannot become a JavaScript thenable. Descriptions must be non-empty
because they document the generated declarations.

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
    signal: AbortSignal,
  ): Promise<ValidationResult>;

  run(
    source: string,
    options: {
      readonly signal: AbortSignal;
      readonly onTelemetry?: (event: TelemetryEvent) => void;
    },
  ): Promise<RunOutcome>;
}
```

`toolbox.typeDefinitions` contains the program contract and the complete
toolbox. It is deterministic and has no runtime side effects.

`runtime.description` is opaque context describing the execution environment.
An embedder may present it to an agent, transform it, combine it with other
instructions, or omit it. Code mode does not interpret the description or
prescribe how an agent harness presents it.

`validate()` uses the released native TypeScript compiler with an in-memory
project. It mounts the toolbox declarations as `codemode.d.ts` and the files
returned by `runtime.loadTypeDefinitionFiles()` at their supplied virtual paths.
Runtime type files are checker-only; they are not included in agent declarations
or sent to the execution runtime. Because the runtime supplies both these files
and the execution channel, checking and execution describe the same target.
Type loading participates in validation cancellation and must stop promptly when
its signal aborts.
Validation enforces the same erasable-only TypeScript subset that execution can
strip. Diagnostics use submitted-source positions; diagnostics and reports are
serializable and bounded.

`run()` does not typecheck. It strips erasable TypeScript syntax in memory, then
executes JavaScript. Syntax unsupported by erasable-only TypeScript is a program
failure. Tool inputs and outputs are always validated on the host, even when the
agent skips checking.

## Outcomes

```ts
type RunOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "program-failed"; readonly error: TelemetryError };
```

Syntax errors, runtime errors, non-void returns, unknown tool calls, handler
errors, and input/output validation errors resolve as `program-failed` outcomes.
Broken runtime transport and violated library invariants reject the promise.
Aborting an execution rejects it after the runtime is
terminated.

Validation failures include a bounded source-framed report. Runtime tool
validation failures also expose a report through
`outcome.error.details.kind === "tool-validation"`.

## Telemetry

Events cover console logs, tool start/completion/failure, and terminal execution
completion/failure.

```ts
const outcome = await client.run(source, {
  signal,
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

Runtime authors import the complete author surface from
`@torkbot/code-mode/runtime`:

```ts
interface Runtime {
  readonly description: string;
  loadTypeDefinitionFiles(
    signal: AbortSignal,
  ): Promise<readonly TypeDefinitionFile[]>;
  start(request: {
    readonly payload: {
      readonly kind: "javascript-module";
      readonly source: string;
    };
    readonly signal: AbortSignal;
  }): Promise<RuntimeInstance>;
}

interface TypeDefinitionFile {
  readonly path: string;
  readonly contents: string;
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

The payload contains all code-mode support code and the submitted agent program.
It is a self-contained ECMAScript module with this entrypoint:

```ts
export function startProgram(channel: ByteChannel): Promise<void>;
```

The description is opaque to code mode. The type definition files describe the
ambient APIs available to checked programs. Agent-authored dynamic imports use
the target environment's normal module resolution.

`start()` evaluates the payload as a module and invokes `startProgram()` exactly
once with the runtime endpoint of a byte channel. The returned instance exposes
the host endpoint: writes to either endpoint's `outgoing` writer arrive in order
on its peer's `incoming` iterable. How those endpoints are connected is entirely
the runtime's decision: in-memory queues, streams, ports, sockets, RPC, and
process pipes are all valid implementations of the same logical channel.

`start()` resolves only after the payload is launched and the host endpoint is
ready. Setup failures reject after partial execution is stopped. After launch,
`finished` always resolves: `closed` means normal completion or requested
termination; `failed` carries an unexpected runtime failure. `terminate()` is
idempotent and resolves after `finished`. Aborting the start signal must stop a
launched execution promptly.

The contract does not contain commands, paths, files, descriptors, environment
variables, process APIs, or vendor objects. A runtime may use any of them
internally, but code mode neither supplies nor observes those mechanics.

## Node Adapters

`@torkbot/code-mode/node` provides `Node24Runtime`. It owns the Node.js 24
checker declarations, target-version check, and bootstrap that adapts the
runtime payload to Node. Its required `Node24RuntimeHost` owns the actual
execution substrate:

```ts
interface Node24RuntimeHost {
  readNodeVersion(signal: AbortSignal): Promise<string>;
  launchNode(request: {
    readonly bootstrapSource: string;
    readonly channelFileDescriptor: number;
    readonly signal: AbortSignal;
  }): Promise<RuntimeInstance>;
}
```

`launchNode()` evaluates the supplied source as the Node entrypoint, connects
the requested full-duplex descriptor, and returns its peer plus lifecycle. It
owns source delivery, cwd, process creation, termination, and errors.
This is a Node adapter boundary, not part of the substrate-neutral `Runtime`
contract.

### Host Node.js

```ts
const runtime = new HostNodeRuntime(process.execPath);
```

The required path must identify a Node.js 24 binary and is checked before type
loading or execution. The generated module is loaded in memory against a virtual
file URL rooted at the child working directory, so bare dynamic imports use
normal Node.js package resolution. The byte channel uses fd 3. The runtime
supplies the bundled Node.js 24 declarations to the checker.

Sandbox-specific Node launching is deliberately not implemented here.
`@torkbot/code-mode-sandbox` owns the `@torkbot/sandbox` host implementation,
including VM lifecycle, spawn options, pipes, cwd, and Sandbox errors, while
reusing `Node24Runtime` for the Node-owned behavior.

## Other JavaScript Runtimes

The payload is an ECMAScript module contract, not a Node process ABI. Deno and
Bun adapters can evaluate the same payload with target-specific declarations
and channel bridges. A Worker or serverless adapter can wrap or upload the
module and connect its endpoint through streams, ports, or provider RPC. A
platform that cannot launch supplied module code, provide the bidirectional
channel, or honor termination does not satisfy `Runtime`; the contract does not
invent a weaker fallback for it.

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
