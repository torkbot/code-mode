import assert from "node:assert/strict";
import test from "node:test";

import { validateAgentSource } from "./index.ts";

const typeDefinitions = `interface CodeModeConsole {
  debug(...values: unknown[]): void;
  error(...values: unknown[]): void;
  info(...values: unknown[]): void;
  log(...values: unknown[]): void;
  warn(...values: unknown[]): void;
}

interface Tools {
  getWeather(input: {
    readonly location: string;
    readonly includeForecast?: boolean;
  }): Promise<{
    readonly conditions: string;
  }>;
}

interface AgentProgramScope {
  readonly codemode: Tools;
  readonly console: CodeModeConsole;
}

type AgentProgram = (scope: AgentProgramScope) => unknown;
`;

test("agent source validation accepts code that matches generated code-mode types", async () => {
  const failure = await validateAgentSource({
    signal: AbortSignal.timeout(5_000),
    typeDefinitions,
    typeDefinitionFiles: [],
    source: `export default async function ({ codemode }: AgentProgramScope) {
      await codemode.getWeather({ location: "London" });
    }`,
  });

  assert.equal(failure, undefined);
});

test("agent source validation checks the program as ESM", async () => {
  const failure = await validateAgentSource({
    signal: AbortSignal.timeout(5_000),
    typeDefinitions,
    typeDefinitionFiles: [],
    source: `export default function () { void import.meta; }`,
  });

  assert.equal(failure, undefined);
});

test("agent source validation returns serializable diagnostics for type errors", async () => {
  const failure = await validateAgentSource({
    signal: AbortSignal.timeout(5_000),
    typeDefinitions,
    typeDefinitionFiles: [],
    source: `export default async function ({ codemode }: AgentProgramScope) {
      await codemode.getWeather({ location: 123 });
    }`,
  });

  assert.equal(failure?.kind, "typecheck");
  assert.deepEqual(JSON.parse(JSON.stringify(failure)), failure);
  assert.equal(failure.diagnostics[0]?.file, "agent.ts");
  assert.equal(failure.diagnostics[0]?.line, 2);
  assert.equal(typeof failure.diagnostics[0]?.column, "number");
  assert.match(failure.diagnostics[0]?.code ?? "", /^TS/);
  assert.match(failure.diagnostics[0]?.message ?? "", /number.*string/);
  assert.match(failure.report, /TypeScript validation failed with 1 diagnostic/);
  assert.match(failure.report, /1\. TS\d+ at agent\.ts:\d+:\d+/);
  assert.match(failure.report, /codemode\.getWeather/);
  assert.match(failure.report, /location: 123/);
  assert.match(failure.report, /\| +\^/);
  assert.ok(failure.report.length < 8_000);
});

test("agent source validation requires a callable default export", async () => {
  const failure = await validateAgentSource({
    signal: AbortSignal.timeout(5_000),
    typeDefinitions,
    typeDefinitionFiles: [],
    source: `export default 42`,
  });

  assert.equal(failure?.kind, "typecheck");
  assert.match(failure.diagnostics[0]?.message ?? "", /number.*AgentProgram/);
  assert.match(failure.report, /number.*AgentProgram/);

  const missing = await validateAgentSource({
    signal: AbortSignal.timeout(5_000),
    typeDefinitions,
    typeDefinitionFiles: [],
    source: `export const value = 42`,
  });
  assert.equal(missing?.kind, "typecheck");
  assert.match(missing.diagnostics[0]?.message ?? "", /no default export/i);
});

test("agent source validation mounts package metadata without checking it as source", async () => {
  const failure = await validateAgentSource({
    signal: AbortSignal.timeout(5_000),
    typeDefinitions,
    typeDefinitionFiles: [
      {
        path: "node_modules/example/package.json",
        contents: JSON.stringify({ types: "index.d.ts" }),
      },
      {
        path: "node_modules/example/index.d.ts",
        contents: "export const value: string;",
      },
    ],
    source: `import { value } from "example";

export default function () {
  void value;
}`,
  });

  assert.equal(failure, undefined);
});

test("agent source validation rejects syntax the runtime cannot erase", async () => {
  const failure = await validateAgentSource({
    signal: AbortSignal.timeout(5_000),
    typeDefinitions,
    typeDefinitionFiles: [],
    source: `export default function () {
      enum Direction { Up }
      void Direction;
    }`,
  });

  assert.equal(failure?.kind, "typecheck");
  assert.match(failure.diagnostics[0]?.message ?? "", /erasableSyntaxOnly/);
});

test("agent source validation treats optional properties as absence-only", async () => {
  const failure = await validateAgentSource({
    signal: AbortSignal.timeout(5_000),
    typeDefinitions,
    typeDefinitionFiles: [],
    source: `export default async function ({ codemode }: AgentProgramScope) {
      await codemode.getWeather({
        location: "London",
        includeForecast: undefined,
      });
    }`,
  });

  assert.equal(failure?.kind, "typecheck");
  assert.match(failure.diagnostics[0]?.message ?? "", /exactOptionalPropertyTypes/);
});

test("agent source validation rejects runtime type path collisions", async () => {
  await assert.rejects(
    validateAgentSource({
      signal: AbortSignal.timeout(5_000),
      typeDefinitions,
      typeDefinitionFiles: [
        { path: "agent.mts", contents: "export default function () {};" },
      ],
      source: "export default function () {}",
    }),
    /path collides with another validation file: agent\.mts/,
  );

  await assert.rejects(
    validateAgentSource({
      signal: AbortSignal.timeout(5_000),
      typeDefinitions,
      typeDefinitionFiles: [
        { path: "runtime.d.ts", contents: "interface RuntimeValue {}" },
        { path: "runtime.d.ts", contents: "interface DifferentValue {}" },
      ],
      source: "export default function () {}",
    }),
    /path collides with another validation file: runtime\.d\.ts/,
  );
});
