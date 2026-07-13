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
   declarations, and evaluate a self-contained JavaScript module over a raw
   bidirectional byte channel. Runtimes own the checking target, execution
   placement, and lifecycle, but never tool schemas, implementations, routing,
   or protocol encoding.

The core contract is independent of a particular execution substrate. Host
Node.js is the first runtime and Node.js inside `@torkbot/sandbox` is the first
isolated runtime. Both must pass the same exported black-box conformance suite.
