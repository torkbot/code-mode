# Vision

Code mode lets an agent replace a long sequence of individual tool round trips
with one checked TypeScript program while the host retains authority over every
tool call.

The project serves three roles:

1. **Embedders** define a toolbox from a name, description, Standard Schema plus
   Standard JSON Schema input/output definitions, and an async host handler.
   They create a client from the toolbox and an execution runtime.
2. **Agent harnesses** expose the complete declarations, checking, execution,
   and live telemetry. Agents repair ordinary type errors and submit one async
   function expression.
3. **Runtime authors** describe the execution environment, supply its checker
   declarations, and launch a required JavaScript-module payload over a raw
   bidirectional byte channel. Runtimes own module evaluation, channel pairing,
   execution placement, and lifecycle, but never tool schemas, implementations,
   routing, or protocol encoding.

The core contract is independent of a particular execution substrate. Host
Node.js is the built-in runtime. Node.js in `@torkbot/sandbox`, Deno, Bun,
workers, and remote sandbox vendors can implement the same contract without
introducing their launch mechanics into core. Every runtime must pass the same
exported black-box conformance suite.
