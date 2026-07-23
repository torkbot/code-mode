import assert from "node:assert/strict";
import test from "node:test";

import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";

import { createToolbox, defineTool } from "../index.ts";
import { testSchema } from "../testing/schema.ts";

test("declarations include schema annotations", () => {
  const toolbox = createToolbox([
    defineTool(
      "getWeather",
      {
        description: "Get weather\nfor a location.",
        inputSchema: testSchema({
          type: "object",
          description: "The weather lookup request.",
          properties: {
            location: {
              type: "string",
              description: "City or place name to look up.",
            },
            includeForecast: {
              type: "boolean",
              description: "Whether to include forecast details.",
            },
          },
          required: ["location"],
          additionalProperties: false,
        } as const),
        outputSchema: testSchema({
          type: "object",
          description: "The current weather report.",
          properties: {
            temperature: {
              type: "number",
              description: "Temperature in degrees Fahrenheit.",
            },
            observedAt: {
              type: "string",
              format: "date-time",
            },
          },
          required: ["temperature", "observedAt"],
          additionalProperties: false,
        } as const),
      },
      async (_ctx, input) => {
        const location: string = input.location;
        const includeForecast: boolean | undefined = input.includeForecast;
        void location;
        void includeForecast;
        return {
          temperature: 72,
          observedAt: "2026-07-09T12:00:00Z",
        };
      },
    ),
  ]);
  assert.match(toolbox.typeDefinitions, /\* Get weather\n +\* for a location/);
  assert.match(toolbox.typeDefinitions, /@param input The weather lookup request/);
  assert.match(toolbox.typeDefinitions, /readonly location: string/);
  assert.match(toolbox.typeDefinitions, /readonly includeForecast\?: boolean/);
  assert.match(toolbox.typeDefinitions, /readonly temperature: number/);
  assert.match(toolbox.typeDefinitions, /@format date-time/);
  assert.match(toolbox.typeDefinitions, /interface CodeModeConsole/);
  assert.match(toolbox.typeDefinitions, /Minimal text console supplied/);
  assert.doesNotMatch(toolbox.typeDefinitions, /declare const console/);
  assert.match(toolbox.typeDefinitions, /Emit ordinary text on stdout/);
  assert.match(toolbox.typeDefinitions, /log\(\.\.\.values: unknown\[\]\): void/);
  assert.match(
    toolbox.typeDefinitions,
    /interface AgentProgramScope \{[\s\S]*readonly codemode: Tools;[\s\S]*readonly console: CodeModeConsole;/,
  );
  assert.match(toolbox.typeDefinitions, /Host tools available to this program/);
  assert.match(toolbox.typeDefinitions, /only console whose output the runtime captures/);
  assert.match(
    toolbox.typeDefinitions,
    /type AgentProgram = \(scope: AgentProgramScope\) => unknown/,
  );
  assert.match(toolbox.typeDefinitions, /default-export a function/);
  assert.match(toolbox.typeDefinitions, /[Ss]tatic imports/);
  assert.doesNotMatch(toolbox.typeDefinitions, /CodeModeGlobalThis/);
  assert.doesNotMatch(toolbox.typeDefinitions, /single async function expression/);
});

test("empty closed object schemas require an object with no keys", () => {
  const empty = testSchema({
    type: "object",
    properties: {},
    additionalProperties: false,
  } as const);
  const toolbox = createToolbox([
    defineTool(
      "ping",
      {
        description: "Ping without arguments.",
        inputSchema: empty,
        outputSchema: empty,
      },
      async () => ({}),
    ),
  ]);

  assert.match(
    toolbox.typeDefinitions,
    /ping<const Input extends Record<string, never>>\(input: Exact<Record<string, never>, Input>\): Promise<Record<string, never>>/,
  );
});

test("type generation requests Standard JSON Schema input and output directions", () => {
  const requested: string[] = [];
  const input = recordingSchema("input-schema", requested);
  const output = recordingSchema("output-schema", requested);
  const toolbox = createToolbox([
      defineTool(
        "convert",
        {
          description: "Convert a value.",
          inputSchema: input,
          outputSchema: output,
        },
        async (_ctx, value) => value,
      ),
    ]);

  assert.match(toolbox.typeDefinitions, /convert/);
  assert.deepEqual(requested, [
    "input-schema:input:draft-2020-12",
    "output-schema:output:draft-2020-12",
  ]);
});

test("toolbox rejects invalid names, duplicate names, and empty descriptions", () => {
  const schema = testSchema({
    type: "object",
    properties: {},
    additionalProperties: false,
  } as const);
  const valid = defineTool(
    "lookup",
    { description: "Look up a value.", inputSchema: schema, outputSchema: schema },
    async () => ({}),
  );
  const reusedDefinition = {
    name: "wrong",
    description: "Keep the explicit name.",
    inputSchema: schema,
    outputSchema: schema,
  };
  const explicitlyNamed = defineTool("right", reusedDefinition, async () => ({}));
  assert.equal(explicitlyNamed.name, "right");
  assert.match(createToolbox([explicitlyNamed]).typeDefinitions, /right<const Input extends/);
  assert.doesNotMatch(createToolbox([explicitlyNamed]).typeDefinitions, /wrong<const Input extends/);

  assert.throws(
    () => createToolbox([
      defineTool(
        "not.valid",
        { description: "Invalid name.", inputSchema: schema, outputSchema: schema },
        async () => ({}),
      ),
    ]),
    /valid JavaScript identifier/,
  );
  assert.throws(
    () => createToolbox([
      defineTool(
        "new",
        { description: "Reserved name.", inputSchema: schema, outputSchema: schema },
        async () => ({}),
      ),
    ]),
    /valid JavaScript identifier/,
  );
  assert.throws(
    () => createToolbox([
      defineTool(
        "then",
        {
          description: "Turn the toolbox into a thenable.",
          inputSchema: schema,
          outputSchema: schema,
        },
        async () => ({}),
      ),
    ]),
    /tool name is reserved: then/,
  );
  assert.throws(
    () => createToolbox([
      defineTool(
        "toString",
        {
          description: "Collide with Object.prototype.",
          inputSchema: schema,
          outputSchema: schema,
        },
        async () => ({}),
      ),
    ]),
    /tool name is reserved: toString/,
  );
  assert.throws(() => createToolbox([valid, valid]), /tool names must be unique/);
  assert.throws(
    () => createToolbox([
      defineTool(
        "undocumented",
        { description: "", inputSchema: schema, outputSchema: schema },
        async () => ({}),
      ),
    ]),
    /description must be a non-empty string/,
  );
  assert.throws(
    () => createToolbox([
      { ...valid, execute: null } as unknown as typeof valid,
    ]),
    /execute must be a function/,
  );
});

test("type generation rejects schemas it cannot represent honestly", () => {
  const unsupported = schemaWithJsonSchema({
    anyOf: [{ type: "string" }, { type: "number" }],
  });
  assert.throws(
    () => createToolbox([
        defineTool(
          "unsupported",
          {
            description: "Use an unsupported schema.",
            inputSchema: unsupported,
            outputSchema: unsupported,
          },
          async (_ctx, value) => value,
        ),
      ]),
    /type must be a string/,
  );

  const openObject = schemaWithJsonSchema({
    type: "object",
    properties: {},
  });
  assert.throws(
    () => createToolbox([
      defineTool(
        "openObject",
        {
          description: "Use an open object schema.",
          inputSchema: openObject,
          outputSchema: openObject,
        },
        async (_ctx, value) => value,
      ),
    ]),
    /additionalProperties must be false/,
  );

  const constrainedString = schemaWithJsonSchema({
    type: "string",
    enum: ["draft", "sent"],
  });
  assert.throws(
    () => createToolbox([
      defineTool(
        "constrained",
        {
          description: "Use an unsupported string constraint.",
          inputSchema: constrainedString,
          outputSchema: constrainedString,
        },
        async (_ctx, value) => value,
      ),
    ]),
    /unsupported keyword: enum/,
  );
});

function recordingSchema(
  label: string,
  requested: string[],
): StandardSchemaV1<string> & StandardJSONSchemaV1<string> {
  return {
    "~standard": {
      version: 1,
      vendor: "code-mode-tests",
      validate(value) {
        return typeof value === "string"
          ? { value }
          : { issues: [{ message: "Expected a string" }] };
      },
      jsonSchema: {
        input(options) {
          requested.push(`${label}:input:${options.target}`);
          return { type: "string" };
        },
        output(options) {
          requested.push(`${label}:output:${options.target}`);
          return { type: "string" };
        },
      },
    },
  };
}

function schemaWithJsonSchema(
  jsonSchema: Record<string, unknown>,
): StandardSchemaV1<unknown> & StandardJSONSchemaV1<unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "code-mode-tests",
      validate: (value) => ({ value }),
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  };
}
