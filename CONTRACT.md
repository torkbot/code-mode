# Code Mode Contract

## Intent

This library turns a large set of host-controlled tools into a compact,
agent-usable TypeScript environment.

The agent receives one declaration set for the available capabilities, checks a
program, repairs ordinary mistakes, and executes many tool calls in one program.
The host remains authoritative for validation, tool
execution, cancellation, policy, and observability. The runtime is only an
execution substrate.

~~~text
agent source -> checked self-contained program -> runtime byte channel -> host tools
~~~

The private wire protocol is not part of any public contract.

## Design Invariants

1. TypeScript and Node.js are the first language/runtime target.
2. Agent source is a single async function expression returning Promise<void>.
3. Agent-correctable failures are resolved values. Broken transport and violated
   library invariants reject.
4. Tool schemas are the source of truth for host validation and generated agent
   types.
5. Runtime adapters never receive tool definitions, schemas, or implementations.
6. Generated programs are self-contained and require no package installation or
   generated files in the execution environment.
7. Checker-only runtime type files are not sent to the agent. The agent receives
   a concise environment description and the complete tool declarations.
8. Required capabilities are required fields rather than optional fallbacks.

## Tool Contract

A tool schema provides both Standard Schema validation and Standard JSON Schema
conversion:

~~~ts
interface ToolSchema<Input, Output> {
  readonly "~standard":
    & StandardSchemaV1.Props<Input, Output>
    & StandardJSONSchemaV1.Props<Input, Output>;
}
~~~

This distinction matters when schemas transform values:

| Boundary | Type |
| --- | --- |
| Agent supplies tool input | InputOf<InputSchema> |
| Handler receives validated input | OutputOf<InputSchema> |
| Handler returns output candidate | InputOf<OutputSchema> |
| Agent receives validated output | OutputOf<OutputSchema> |

The API keeps one cohesive definition per tool while using defineTool() as a
clean TypeScript inference boundary:

~~~ts
const toolbox = createToolbox([
  defineTool(
    "getWeather",
    {
      description: "Get weather for a location.",
      inputSchema: WeatherInput,
      outputSchema: WeatherOutput,
    },
    async (ctx, input) => {
      ctx.signal.throwIfAborted();
      return await weather.get(input.location);
    },
  ),
]);

const toolDeclarations = toolbox.typeDefinitions;
~~~

Tool names must be unique JavaScript identifiers other than `then`, which is
reserved so the tool object cannot become a JavaScript thenable. Tool descriptions
must be non-empty because they document generated declarations. Object schemas
must explicitly set additionalProperties to false. Schema annotations are
guidance, not correctness gates. Type generation rejects only schema constructs
that cannot be represented without misleading the agent.

## Embedder API

The embedder creates one client from a toolbox, an execution runtime, and an
explicit checking environment:

~~~ts
const environment = {
  description: "Node.js 24.13 on Alpine Linux 3.23",
  typeDefinitionFiles: await readNode24TypeDefinitions(),
};

const client = createClient({ toolbox, runtime, environment });
~~~

The runtime owns transport and lifecycle only. The environment owns the
human-readable runtime facts and checker-only ambient declarations.

~~~ts
interface Client {
  validate(
    source: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ValidationResult>;

  run(
    source: string,
    options?: {
      readonly signal?: AbortSignal;
      readonly onTelemetry?: (event: TelemetryEvent) => void;
    },
  ): Execution;
}

~~~

toolbox.typeDefinitions contains the program contract and declarations for the
complete toolbox. environment.description is concise agent-facing context.
environment.typeDefinitionFiles is the checker-only virtual file tree. The
library does not impose a discovery, selection, search, or pagination protocol.

validate() checks only. It never launches a runtime or calls a tool. run()
executes only. It performs host-side input/output validation but does not
implicitly typecheck.

## Runtime Author API

~~~ts
interface Runtime {
  start(request: {
    readonly program: Program;
    readonly signal: AbortSignal;
  }): Promise<RuntimeInstance>;
}

type Program = JavaScriptModuleProgram;

interface JavaScriptModuleProgram {
  readonly kind: "javascript-module";
  readonly source: string;
}

interface RuntimeInstance {
  readonly channel: ByteChannel;
  readonly finished: Promise<RuntimeFinished>;
  terminate(reason: string): Promise<void>;
}

interface ByteChannel {
  readonly incoming: AsyncIterable<Uint8Array>;
  readonly outgoing: {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
  };
}

type RuntimeFinished =
  | { readonly kind: "closed" }
  | { readonly kind: "failed"; readonly error: Error };
~~~

The JavaScript module is self-contained and exports:

~~~ts
export function startProgram(channel: ByteChannel): Promise<void>;
~~~

A runtime evaluates the module, invokes startProgram(channel), and reports
lifecycle completion. It does not decode messages or inject globals.

For Node.js, built-in adapters evaluate a bootstrap as an ES module. The
bootstrap loads the generated source in memory against a virtual file URL rooted
at the child working directory, adapts one full-duplex descriptor to ByteChannel,
and invokes startProgram(). Bare dynamic imports therefore use normal Node.js
package resolution without requiring a generated file.

## Agent Contract

The recommended model-facing operations are equivalent to:

~~~ts
get_codemode_types() -> toolbox.typeDefinitions
check_codemode({ source }) -> client.validate(source)
run_codemode({ source }) -> await client.run(source, options).result
~~~

The normal agent loop is:

1. Read the declarations.
2. Submit a single async function expression.
3. Check it and repair any diagnostics.
4. Run it.
5. Inspect the resolved outcome and bounded telemetry returned by the harness.

Generated declarations tell the agent to use dynamic import() for runtime
modules, return no value, avoid markdown fences, and submit only the function
expression. They also declare the runtime-supplied debug, error, info, log, and
warn console methods.

An agent may skip checking when latency matters. Execution remains safe because
all tool inputs and outputs are validated on the host.

## Failure Contract

validate() resolves:

~~~ts
type ValidationResult =
  | { readonly kind: "valid" }
  | {
      readonly kind: "invalid";
      readonly diagnostics: readonly Diagnostic[];
      readonly report: string;
    };
~~~

run().result resolves when runtime plumbing worked:

~~~ts
type RunOutcome =
  | { readonly kind: "success" }
  | {
      readonly kind: "program-failed";
      readonly error: {
        readonly name: string;
        readonly message: string;
        readonly stack: string | null;
        readonly details:
          | { readonly kind: "tool-validation"; readonly report: string }
          | null;
      };
    };
~~~

Syntax/runtime errors, propagated tool failures, non-void returns, and tool
validation failures are program outcomes. Spawn failures, malformed protocol
messages, impossible lifecycle transitions, and broken internal invariants
reject.

## Black-Box Conformance Suite

The exported suite accepts only an async runtime factory:

~~~ts
testRuntime({
  name: "sandbox-node",
  createRuntime: async () => runtime,
});
~~~

It must not inspect the adapter or assume processes, files, Node.js, descriptors,
or a particular chunking strategy.

The suite is organized into non-overlapping behavioral groups:

1. **Agent journey**: declarations, failed check, repaired check, successful run.
2. **Declarations**: completeness, ordering, determinism, environment guidance,
   schema transformations, and formats.
3. **Static checking**: syntax, unknown tools, bad inputs, non-void programs,
   serializable bounded diagnostics, cancellation, and proof that checking does
   not execute.
4. **Execution semantics**: sequential, parallel, and interleaved calls;
   transformed inputs/outputs; program, tool, and validation failures; proof
   that run does not typecheck.
5. **Telemetry**: ordering, execution/tool correlation, logs and structured
   values, terminal events, and callback isolation.
6. **Lifecycle and isolation**: concurrent executions, independent toolboxes,
   abort before and during execution, runtime failure, termination, and no
   cross-execution leakage.
7. **Transport opacity**: arbitrary frame chunking/coalescing and clean/truncated
   closure, exercised through public behavior rather than protocol imports.

Host Node.js is the first conformance instance. Sandbox Node.js is the second and
must run the same suite unchanged.
