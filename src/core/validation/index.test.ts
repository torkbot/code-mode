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

type CodeModeGlobalThis = Omit<typeof globalThis, "console" | "globalThis"> & {
  readonly console: CodeModeConsole;
  readonly globalThis: CodeModeGlobalThis;
};

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
}

type AgentProgram = (scope: AgentProgramScope) => Promise<void>;
`;

test("agent source validation accepts code that matches generated code-mode types", async () => {
  const failure = await validateAgentSource({
    signal: AbortSignal.timeout(5_000),
    typeDefinitions,
    typeDefinitionFiles: [],
    source: `async ({ codemode }) => {
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
    source: `async () => { void import.meta; }`,
  });

  assert.equal(failure, undefined);
});

test("agent source validation returns serializable diagnostics for type errors", async () => {
  const failure = await validateAgentSource({
    signal: AbortSignal.timeout(5_000),
    typeDefinitions,
    typeDefinitionFiles: [],
    source: `async ({ codemode }) => {
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

test("agent source validation requires promise to void", async () => {
  const failure = await validateAgentSource({
    signal: AbortSignal.timeout(5_000),
    typeDefinitions,
    typeDefinitionFiles: [],
    source: `async () => "not void"`,
  });

  assert.equal(failure?.kind, "typecheck");
  assert.match(failure.diagnostics[0]?.message ?? "", /Promise<string>.*Promise<void>/);
  assert.match(failure.report, /Promise<string>.*Promise<void>/);
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
    source: `async () => {
      const example = await import("example");
      void example.value;
    }`,
  });

  assert.equal(failure, undefined);
});

test("agent source validation rejects syntax the runtime cannot erase", async () => {
  const failure = await validateAgentSource({
    signal: AbortSignal.timeout(5_000),
    typeDefinitions,
    typeDefinitionFiles: [],
    source: `async () => {
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
    source: `async ({ codemode }) => {
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
        { path: "agent.mts", contents: "async () => {};" },
      ],
      source: "async () => {}",
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
      source: "async () => {}",
    }),
    /path collides with another validation file: runtime\.d\.ts/,
  );
});
