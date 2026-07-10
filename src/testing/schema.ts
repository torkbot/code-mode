import Schema from "typebox/schema";

import type { ToolSchema } from "../core/types.ts";

export type TestJsonSchema =
  | {
      readonly type: "object";
      readonly properties: Readonly<Record<string, TestJsonSchema>>;
      readonly required?: readonly string[];
      readonly [key: string]: unknown;
    }
  | {
      readonly type: "array";
      readonly items: TestJsonSchema;
      readonly [key: string]: unknown;
    }
  | {
      readonly type: "string" | "number" | "integer" | "boolean" | "null";
      readonly [key: string]: unknown;
    };

export type TestJsonSchemaValue<Value extends TestJsonSchema> =
  Value extends {
    readonly type: "object";
    readonly properties: infer Properties extends Readonly<Record<string, TestJsonSchema>>;
    readonly required?: infer Required;
  }
    ? ObjectValue<Properties, Required>
    : Value extends { readonly type: "array"; readonly items: infer Items extends TestJsonSchema }
      ? readonly TestJsonSchemaValue<Items>[]
      : Value extends { readonly type: "string" }
        ? string
        : Value extends { readonly type: "number" | "integer" }
          ? number
          : Value extends { readonly type: "boolean" }
            ? boolean
            : Value extends { readonly type: "null" }
              ? null
              : unknown;

type ObjectValue<
  Properties extends Readonly<Record<string, TestJsonSchema>>,
  Required,
> = {
  readonly [Key in keyof Properties as Key extends Extract<Required, readonly string[]>[number]
    ? Key
    : never]: TestJsonSchemaValue<Properties[Key]>;
} & {
  readonly [Key in keyof Properties as Key extends Extract<Required, readonly string[]>[number]
    ? never
    : Key]?: TestJsonSchemaValue<Properties[Key]>;
};

export function testSchema<const Value extends TestJsonSchema>(
  value: Value,
): ToolSchema<TestJsonSchemaValue<Value>> {
  const validator = Schema.Compile(value as never) as TestValidator;

  return {
    "~standard": {
      version: 1,
      vendor: "@torkbot/code-mode-tests",
      validate(input) {
        const [valid, errors] = validator.Errors(input);
        if (valid) {
          return { value: input as TestJsonSchemaValue<Value> };
        }
        return {
          issues: errors.map((error) => ({
            message: error.message,
            path: parseJsonPointer(error.instancePath),
          })),
        };
      },
      jsonSchema: {
        input: () => value,
        output: () => value,
      },
    },
  };
}

export function testTransformSchema<Input, Output>(options: {
  readonly inputJsonSchema: Record<string, unknown>;
  readonly outputJsonSchema: Record<string, unknown>;
  validate(value: unknown):
    | StandardSchemaResult<Output>
    | Promise<StandardSchemaResult<Output>>;
}): ToolSchema<Input, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "@torkbot/code-mode-tests",
      validate: options.validate,
      jsonSchema: {
        input: () => options.inputJsonSchema,
        output: () => options.outputJsonSchema,
      },
    },
  };
}

type StandardSchemaResult<Output> =
  | { readonly value: Output }
  | { readonly issues: readonly { readonly message: string; readonly path?: readonly PropertyKey[] }[] };

interface TestValidator {
  Errors(value: unknown): readonly [boolean, readonly TestValidationError[]];
}

interface TestValidationError {
  readonly instancePath: string;
  readonly message: string;
}

function parseJsonPointer(pointer: string): readonly PropertyKey[] | undefined {
  if (pointer === "" || pointer === "/") {
    return undefined;
  }
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}
