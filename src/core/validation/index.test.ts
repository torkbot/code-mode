import assert from "node:assert/strict";
import test from "node:test";

import { validateAgentSource } from "./index.ts";

const typeDefinitions = `interface Tools {
  getWeather(input: {
    readonly location: string;
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
  assert.equal(typeof failure.diagnostics[0]?.line, "number");
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
