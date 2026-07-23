# Vision

Code mode lets an agent replace a long sequence of tool round trips with one
checked TypeScript ESM program while the host retains authority over every tool
call.

The project serves three roles:

1. **Embedders** define a flat toolbox from names, descriptions, Standard Schema
   plus Standard JSON Schema definitions, and async host handlers. They create a
   client over one live runtime and own that runtime's lifetime.
2. **Agent harnesses** expose generated declarations, checking, execution, and
   live telemetry. Agents submit ordinary ESM with static imports and a callable
   default export. The runner supplies `{ codemode, console }`; only that console
   is captured, as text with stdout/stderr provenance.
3. **Runtime driver authors** boot an environment, wire one standard runner to a
   raw byte connection, supply checker declarations, and evaluate each request
   as a fresh root ESM module. Drivers own placement, native module resolution,
   scheduling, isolation strength, and resource lifecycle. They never own tool
   schemas, implementations, routing, correlation IDs, or protocol encoding.

The core contract is a client/server lifecycle, independent of a particular
execution substrate. Boot establishes a connected runner; execution requests
then carry programs and their interaction over that connection. The same runner
ships as a normal module and as flattened, self-contained source for platforms
that cannot preinstall the package.

Host Node.js is the built-in multiplexed driver. `@torkbot/code-mode-sandbox`,
workers, serverless platforms, isolates, microVMs, and sandbox vendors can use
the same runtime factory and runner without importing their launch mechanics
into core. Every implementation must pass the public black-box conformance
suite.
