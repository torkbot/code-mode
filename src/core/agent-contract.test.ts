import assert from "node:assert/strict";
import test from "node:test";

import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";

import { createToolbox, defineTool } from "../index.ts";

test("toolbox exposes complete ordered agent declarations", () => {
  const toolbox = createToolbox([
    defineTool(
      "getWeather",
      {
        description: "Get weather for a location.",
        inputSchema: objectSchema<{ readonly location: string }>({
          properties: {
            location: {
              type: "string",
              description: "City or place name.",
            },
          },
          required: ["location"],
        }),
        outputSchema: objectSchema<{ readonly temperature: number }>({
          properties: {
            temperature: { type: "number" },
          },
          required: ["temperature"],
        }),
      },
      async (_ctx, input) => {
        assert.equal(typeof input.location, "string");
        return { temperature: 20 };
      },
    ),
    defineTool(
      "sendEmail",
      {
        description: "Send an email message.",
        inputSchema: objectSchema<{ readonly to: string }>({
          properties: {
            to: { type: "string" },
          },
          required: ["to"],
        }),
        outputSchema: objectSchema<{ readonly sent: boolean }>({
          properties: {
            sent: { type: "boolean" },
          },
          required: ["sent"],
        }),
      },
      async () => ({ sent: true }),
    ),
  ]);
  assert.match(toolbox.typeDefinitions, /getWeather/);
  assert.match(toolbox.typeDefinitions, /sendEmail/);
  assert.ok(
    toolbox.typeDefinitions.indexOf("getWeather")
      < toolbox.typeDefinitions.indexOf("sendEmail"),
  );
  assert.match(toolbox.typeDefinitions, /type AgentProgram/);
});

test("tool schemas type each side of input and output transformations", async () => {
  const inputSchema = schema<
    { readonly value: string },
    { readonly value: number }
  >(
    {
      type: "object",
      properties: {
        value: { type: "string" },
      },
      required: ["value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        value: { type: "number" },
      },
      required: ["value"],
      additionalProperties: false,
    },
    (value) => {
      const input = value as { readonly value: string };
      return { value: { value: Number(input.value) } };
    },
  );
  const outputSchema = schema<
    { readonly value: number },
    { readonly formatted: string }
  >(
    {
      type: "object",
      properties: {
        value: { type: "number" },
      },
      required: ["value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        formatted: { type: "string" },
      },
      required: ["formatted"],
      additionalProperties: false,
    },
    (value) => {
      const output = value as { readonly value: number };
      return { value: { formatted: String(output.value) } };
    },
  );

  const tool = defineTool(
    "transform",
    {
      description: "Transform a value.",
      inputSchema,
      outputSchema,
    },
    async (_ctx, input) => {
      const value: number = input.value;
      // @ts-expect-error the handler receives the transformed input
      const wrongInput: string = input.value;
      void wrongInput;
      return { value };
    },
  );

  const badTool = defineTool(
    "badTransform",
    {
      description: "Return the wrong pre-validation output.",
      inputSchema,
      outputSchema,
    },
    // @ts-expect-error the handler must return the output schema input
    async () => ({ formatted: "wrong side" }),
  );
  void badTool;

  const toolbox = createToolbox([tool]);
  assert.match(
    toolbox.typeDefinitions,
    /transform\(input: \{[\s\S]*value: string[\s\S]*Promise<\{[\s\S]*formatted: string/,
  );
});

function objectSchema<T>(
  value: {
    readonly properties: Readonly<Record<string, Record<string, unknown>>>;
    readonly required: readonly string[];
  },
): StandardSchemaV1<T> & StandardJSONSchemaV1<T> {
  return schema<T, T>(
    { type: "object", ...value, additionalProperties: false },
    { type: "object", ...value, additionalProperties: false },
    (input) => ({ value: input as T }),
  );
}

function schema<Input, Output>(
  inputJsonSchema: Record<string, unknown>,
  outputJsonSchema: Record<string, unknown>,
  validate: (
    value: unknown,
  ) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>,
): StandardSchemaV1<Input, Output> & StandardJSONSchemaV1<Input, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "code-mode-tests",
      validate,
      jsonSchema: {
        input: () => inputJsonSchema,
        output: () => outputJsonSchema,
      },
    },
  } as StandardSchemaV1<Input, Output> & StandardJSONSchemaV1<Input, Output>;
}
