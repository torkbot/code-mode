# @torkbot/code-mode

Run agent-authored TypeScript ESM against host-controlled tools on a pluggable,
long-lived JavaScript runtime.

Code mode owns tool declarations, checking, TypeScript erasure, host-side schema
validation, tool routing, telemetry, and its internal wire protocol. Runtime
drivers own where programs execute, how modules resolve, how the runner is
booted, and how strongly execution can be isolated or cancelled.

## Install

```sh
npm install @torkbot/code-mode
```

The library requires Node.js 24 or newer on the host. Agent programs can run in
any environment with a conforming runtime driver.

## Quick start

```ts
import {
  createClient,
  createToolbox,
  defineTool,
} from "@torkbot/code-mode";
import { createHostNodeRuntime } from "@torkbot/code-mode/host-node";

const toolbox = createToolbox([
  defineTool(
    "getWeather",
    {
      description: "Get weather for a location.",
      inputSchema: WeatherInput,
      outputSchema: WeatherReport,
    },
    async ({ signal }, input) => {
      signal.throwIfAborted();
      return weatherService.get(input.location, { signal });
    },
  ),
]);

const runtime = await createHostNodeRuntime(
  {
    nodePath: process.execPath,
    cwd: process.cwd(),
  },
  AbortSignal.timeout(5_000),
);

try {
  const client = createClient({ runtime, toolbox });
  const source = `
import { inspect } from "node:util";

export default async function ({ codemode, console }: AgentProgramScope) {
  const weather = await codemode.getWeather({ location: "London" });
  console.log(inspect(weather));
}
`.trimStart();

  const validation = await client.validate(
    source,
    AbortSignal.timeout(5_000),
  );
  if (validation.kind === "invalid") {
    throw new Error(validation.report);
  }

  const outcome = await client.run(source, {
    signal: AbortSignal.timeout(30_000),
    onTelemetry(event) {
      if (event.kind === "program-output") {
        process[event.stream].write(event.text);
      }
    },
  });
} finally {
  await runtime[Symbol.asyncDispose]();
}
```

`createHostNodeRuntime()` starts one Node.js process and returns after its runner
is ready. Every subsequent `client.run()` is an execution request on that live
connection. Dispose the runtime when its owner is done with it.

## Program contract

A submitted program is a real ECMAScript module. It may use static imports and
must have a callable default export assignable to:

```ts
interface AgentProgramScope {
  readonly codemode: Tools;
  readonly console: CodeModeConsole;
}

type AgentProgram = (scope: AgentProgramScope) => unknown;
```

The runner evaluates a fresh root module for every execution, calls its default
export with `{ codemode, console }`, awaits it, and ignores its fulfilled value.
A program can use either scope field, both, or neither. There is no continuity
between root modules; a runtime may still use its platform's normal cache for
imported dependencies.

Only the `console` passed in `AgentProgramScope` is captured. Calls to an ambient
global console or an imported console are outside the runtime contract. The
captured console has this minimum surface:

```ts
interface CodeModeConsole {
  debug(...values: unknown[]): void;
  error(...values: unknown[]): void;
  info(...values: unknown[]): void;
  log(...values: unknown[]): void;
  warn(...values: unknown[]): void;
}
```

Runtimes format console arguments. Code mode only promises text chunks and
their provenance:

```ts
type ProgramOutput = {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
};
```

The consumer is expected to interpret text. There is no structured-value,
circular-reference, or console-formatting contract.

`validate()` checks the submitted module itself. `run()` uses Amaro's strip-only
transform to erase TypeScript in place, with no parser-owned wrapper and no
prepended source. Runtime stacks therefore retain submitted line and column
coordinates.

## Tools and checking

Every tool input and output schema implements both `StandardSchemaV1` and
`StandardJSONSchemaV1`:

```ts
type ToolSchema<Input, Output> =
  & StandardSchemaV1<Input, Output>
  & StandardJSONSchemaV1<Input, Output>;
```

Standard Schema validates and transforms values on the host. Standard JSON
Schema generates exact agent-facing declarations. Transforming schemas have
four distinct type positions:

| Boundary | Type |
| --- | --- |
| Program supplies tool input | `SchemaInput<InputSchema>` |
| Handler receives validated input | `SchemaOutput<InputSchema>` |
| Handler returns an output candidate | `SchemaInput<OutputSchema>` |
| Program receives validated output | `SchemaOutput<OutputSchema>` |

Tool names must be unique JavaScript identifiers. `then` and the inherited
`Object` property names are reserved. Descriptions must be non-empty because
they become user-facing JSDoc in generated declarations.

The declaration printer supports closed objects, arrays, strings, numbers,
integers, booleans, and null. Object schemas must explicitly set
`additionalProperties: false`; unsupported schema constructs fail instead of
being represented loosely.

`toolbox.typeDefinitions` contains the complete program and tool contract.
`Runtime.loadTypeDefinitionFiles()` supplies checker-only declarations for the
execution environment. Those files are mounted in an in-memory TypeScript
project and are never sent as part of an execution request.

`validate()` has no runtime side effects. `run()` does not implicitly typecheck,
but tool inputs and outputs are always validated on the host.
Tool values crossing a runtime connection must also be JSON-compatible;
non-JSON inputs or handler results fail that program without closing the shared
runtime.

## Outcomes, cancellation, and telemetry

```ts
type RunOutcome =
  | { readonly kind: "success" }
  | {
      readonly kind: "program-failed";
      readonly error: TelemetryError;
    };
```

Module evaluation errors, a non-callable default export, thrown or rejected
programs, unknown tools, handler failures, and schema failures resolve as
`program-failed`. The default export's fulfilled value never affects the
outcome. Transport failures and execution cancellation reject the promise.

An execution signal governs only that execution and its active tool handlers.
It does not close the runtime or cancel other multiplexed executions.

Telemetry reports:

- `program-output` with `stream` and `text`;
- tool call start, completion, and failure;
- terminal execution completion or infrastructure failure.

Telemetry callbacks are observational. Their throws and rejected promises do
not alter program execution.

## Runtime lifecycle

The public runtime used by a client is already connected:

```ts
interface Runtime extends AsyncDisposable {
  readonly description: string;
  readonly finished: Promise<RuntimeFinished>;

  loadTypeDefinitionFiles(
    signal: AbortSignal,
  ): Promise<readonly TypeDefinitionFile[]>;

  execute(request: {
    readonly source: string;
    readonly signal: AbortSignal;
    invokeTool(call: RuntimeToolCall): Promise<unknown>;
    emitOutput(output: {
      readonly stream: "stdout" | "stderr";
      readonly text: string;
    }): void;
  }): Promise<RunOutcome>;

  [Symbol.asyncDispose](): Promise<void>;
}
```

`description` is opaque environment context an embedder may present to an
agent. `finished` always resolves when the runtime becomes unusable: `closed`
for an orderly end, or `failed` with the underlying error. Async disposal closes
the connection and waits for driver-owned resources to stop.

Scheduling belongs to the driver. Clients always receive promises; a driver may
serialize them. The built-in Host Node driver is fully multiplexed.

## Authoring a runtime driver

Driver authors use `@torkbot/code-mode/runtime`:

```ts
interface RuntimeDriver<Options> {
  readonly description: string;

  loadTypeDefinitionFiles(
    signal: AbortSignal,
  ): Promise<readonly TypeDefinitionFile[]>;

  connect(
    options: Options,
    request: {
      readonly runnerSource: string;
      readonly signal: AbortSignal;
    },
  ): Promise<RuntimeConnection>;
}

interface RuntimeConnection extends AsyncDisposable {
  readonly channel: {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
  };
  readonly finished: Promise<RuntimeFinished>;
  [Symbol.asyncDispose](): Promise<void>;
}
```

Expose a user-facing factory by closing over the driver:

```ts
import { createRuntimeFactory } from "@torkbot/code-mode/runtime";

const driver: RuntimeDriver<MyOptions> = {
  description: "My runtime",
  loadTypeDefinitionFiles,
  connect,
};

export const createMyRuntime = createRuntimeFactory(driver);
```

The factory owns the version-matched runner, readiness handshake, internal
execution IDs, wire protocol, and failed-boot cleanup. Its signal governs boot
through readiness and then detaches. The caller that creates the runtime owns
its later lifetime.

`connect()` boots the execution environment, wires one runner to the returned
byte channel, and returns the connection. The driver can use any process,
isolate, VM, worker, socket, provider API, or in-memory transport. Agent source,
tool calls, output, outcomes, cancellation, and opaque correlation are carried
by execution requests after boot; they are not driver options.

The byte framing and messages are internal to this package. Drivers transport
bytes; they do not reproduce or interpret the protocol.

### Bootstrapping the runner

Platforms that can preinstall the package use the normal ESM export:

```ts
import { startRunner } from "@torkbot/code-mode/runner";

await startRunner({
  channel,
  schedule: (execute) => execute(),
  importModule: ({ source, signal }) => importFreshRoot(source, signal),
  createConsole: (emit) => createPlatformConsole(emit),
});
```

Some runtimes cannot preinstall npm modules. Every `connect()` request therefore
also receives `runnerSource`: self-contained ESM source exporting the same
`startRunner()` implementation. A driver can evaluate or upload that source and
append only its platform glue. The equivalent artifact is exported from
`@torkbot/code-mode/runner/source` for driver tooling and inspection, but normal
runtime users never plumb it.

`schedule()` wraps the complete module-evaluation and default-export invocation.
Call its callback immediately to multiplex, or queue callbacks to serialize a
runtime. `importModule()` must evaluate each request as a fresh root ESM module
and use the target's native static-import resolution. Its signal provides
logical cancellation; runtimes with stronger interruption primitives can apply
them there. `createConsole()` must call `emit` with text plus `stdout` or
`stderr`.

### Authoring a Node.js 24 driver

Node.js 24 driver authors can reuse code-mode's version-matched declarations
and guest execution semantics without adopting the built-in Host Node process
lifecycle:

```ts
import {
  assertNode24Version,
  createNode24BootstrapSource,
  loadNode24TypeDefinitionFiles,
} from "@torkbot/code-mode/node-runtime";

const driver: RuntimeDriver<MyNodeOptions> = {
  description: "My Node.js 24 runtime",
  loadTypeDefinitionFiles: loadNode24TypeDefinitionFiles,
  async connect(options, { runnerSource, signal }) {
    const version = await readRuntimeNodeVersion(options, signal);
    assertNode24Version(version, "My Node runtime");

    const bootstrapSource = createNode24BootstrapSource({
      runnerSource,
      channelFileDescriptor: 3,
    });
    return launchRuntimeNode(options, bootstrapSource, signal);
  },
};
```

The generated self-contained ESM attaches to the supplied full-duplex file
descriptor, multiplexes executions, evaluates fresh root modules with native
Node resolution from `process.cwd()`, and constructs the captured console with
`node:console`. The driver still owns how the source reaches Node, how the file
descriptor is connected, ambient stdio, boot cancellation, and process
lifecycle. This keeps Host Node, Sandbox Node, and other Node substrates aligned
without importing each other's launch mechanics.

## Built-in Host Node driver

```ts
import { createHostNodeRuntime } from "@torkbot/code-mode/host-node";

const runtime = await createHostNodeRuntime(
  { nodePath: process.execPath, cwd: process.cwd() },
  bootSignal,
);
```

The driver requires Node.js 24. It starts one long-lived child process per
runtime, connects its runner over fd 3, and multiplexes executions. Programs use
native Node ESM resolution rooted at `cwd`, including ordinary ESM/CJS package
interop. The child constructs the captured console with `node:console`; its
ambient stdout, stderr, and global console are not program-output channels.

Host Node is not a sandbox. Use it for trusted programs and conformance tests.
Sandbox vendors and `@torkbot/code-mode-sandbox` should implement their own
driver while reusing the standard factory and the Node runtime authoring
surface where applicable.

Node retains each unique root module record in its module map until the runtime
process is disposed. Imported dependencies may also remain cached. Code mode
does not pretend to evict native module records or add process recycling policy;
runtime owners should choose a lifecycle appropriate to their workload. To
observe the retained-memory profile locally:

```sh
npm run benchmark:host-node-memory
```

The benchmark reports samples and does not impose a universal pass/fail limit.

## Runtime conformance

Every driver should run the exported black-box suite:

```ts
import { testRuntime } from "@torkbot/code-mode/testing";

testRuntime({
  name: "my runtime",
  createRuntime(signal) {
    return createMyRuntime(requiredOptions, signal);
  },
});
```

The suite creates and disposes arbitrary runtime instances. It exercises both
the public `Runtime` interface and the public client journey without observing a
driver, connection, process, or wire message.

## Breaking migration

This version replaces the previous execution stack instead of adapting it:

- submit ESM with a callable default export, not a function expression;
- read both `codemode` and the captured `console` from the scope argument;
- create a connected runtime with an async factory, then dispose it;
- implement `RuntimeDriver.connect()` for new platforms, not
  `Runtime.start()`/`RuntimeInstance`/payload launch layers;
- consume `program-output` text with explicit stdout/stderr provenance, not
  structured console values;
- import the built-in factory from `@torkbot/code-mode/host-node`; the old
  `@torkbot/code-mode/node` adapter surface is removed.
