import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";

export type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
  StandardTypedV1,
} from "@standard-schema/spec";

export type ToolSchema<Input = unknown, Output = Input> =
  & StandardSchemaV1<Input, Output>
  & StandardJSONSchemaV1<Input, Output>;

export type SchemaInput<Schema extends ToolSchema<any, any>> =
  StandardSchemaV1.InferInput<Schema>;

export type SchemaOutput<Schema extends ToolSchema<any, any>> =
  StandardSchemaV1.InferOutput<Schema>;

export interface ToolDefinition<
  InputSchema extends ToolSchema<any, any> = ToolSchema<any, any>,
  OutputSchema extends ToolSchema<any, any> = ToolSchema<any, any>,
> {
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
}

export interface ToolExecutionContext {
  readonly signal: AbortSignal;
}

export type ToolHandler<
  InputSchema extends ToolSchema<any, any> = ToolSchema<any, any>,
  OutputSchema extends ToolSchema<any, any> = ToolSchema<any, any>,
> = (
  ctx: ToolExecutionContext,
  input: SchemaOutput<NoInfer<InputSchema>>,
) => Promise<SchemaInput<NoInfer<OutputSchema>>>;

export interface ExecutableToolDefinition<
  Name extends string = string,
  InputSchema extends ToolSchema<any, any> = ToolSchema<any, any>,
  OutputSchema extends ToolSchema<any, any> = ToolSchema<any, any>,
> extends ToolDefinition<InputSchema, OutputSchema> {
  readonly name: Name;
  execute: ToolHandler<InputSchema, OutputSchema>;
  readonly [executableToolDefinitionBrand]: {
    readonly inputSchema: InputSchema;
    readonly outputSchema: OutputSchema;
  };
}

export interface Toolbox {
  readonly typeDefinitions: string;
  readonly [toolboxBrand]: true;
}

export type ExecutableToolDefinitions = Readonly<Record<string, ExecutableToolDefinition>>;

export interface TypeGenerationRequest {
  readonly tools: readonly ExecutableToolDefinition[];
}

const executableToolDefinitionBrand: unique symbol = Symbol("ExecutableToolDefinition");
const toolboxBrand: unique symbol = Symbol("Toolbox");

interface ToolboxState {
  readonly list: readonly ExecutableToolDefinition[];
  readonly byName: ExecutableToolDefinitions;
}

const toolboxStates = new WeakMap<Toolbox, ToolboxState>();

export function defineTool<
  const Name extends string,
  const InputSchema extends ToolSchema<any, any>,
  const OutputSchema extends ToolSchema<any, any>,
>(
  name: Name,
  definition: ToolDefinition<InputSchema, OutputSchema>,
  execute: ToolHandler<InputSchema, OutputSchema>,
): ExecutableToolDefinition<Name, InputSchema, OutputSchema> {
  return {
    name,
    ...definition,
    execute,
    [executableToolDefinitionBrand]: {
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
    },
  };
}

export function createToolbox(tools: readonly ExecutableToolDefinition[]): Toolbox {
  if (!Array.isArray(tools)) {
    throw new Error("Code-mode tools must be an array");
  }

  const list = [...tools];
  const byName: Record<string, ExecutableToolDefinition> = Object.create(null);

  for (const tool of list) {
    const toolValue: unknown = tool;
    assertRecord(toolValue, "tool");
    assertIdentifier(tool.name, "tool name");
    assertNonEmptyString(tool.description, `tool ${tool.name} description`);
    assertToolSchema(tool.inputSchema, `tool ${tool.name} inputSchema`);
    assertToolSchema(tool.outputSchema, `tool ${tool.name} outputSchema`);

    if (Object.hasOwn(byName, tool.name)) {
      throw new Error(`Code-mode tool names must be unique: ${tool.name}`);
    }

    byName[tool.name] = tool;
  }

  const toolbox: Toolbox = {
    typeDefinitions: generateTypes({ tools: list }),
    [toolboxBrand]: true,
  };
  toolboxStates.set(toolbox, { list, byName });
  return toolbox;
}

export function getToolboxTools(toolbox: Toolbox): ExecutableToolDefinitions {
  return getToolboxState(toolbox).byName;
}

export function getToolboxToolList(toolbox: Toolbox): readonly ExecutableToolDefinition[] {
  return getToolboxState(toolbox).list;
}

function getToolboxState(toolbox: Toolbox): ToolboxState {
  const state = toolboxStates.get(toolbox);

  if (state === undefined) {
    throw new Error("Code-mode toolbox must be created with createToolbox");
  }

  return state;
}

export type SupportedJsonSchema =
  | ObjectJsonSchema
  | ArrayJsonSchema
  | StringJsonSchema
  | NumberJsonSchema
  | IntegerJsonSchema
  | BooleanJsonSchema
  | NullJsonSchema;

export interface ObjectJsonSchema {
  readonly type: "object";
  readonly description?: string;
  readonly properties: Readonly<Record<string, SupportedJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface ArrayJsonSchema {
  readonly type: "array";
  readonly description?: string;
  readonly items: SupportedJsonSchema;
}

export interface StringJsonSchema {
  readonly type: "string";
  readonly description?: string;
  readonly format?: string;
}

export interface NumberJsonSchema {
  readonly type: "number";
  readonly description?: string;
}

export interface IntegerJsonSchema {
  readonly type: "integer";
  readonly description?: string;
}

export interface BooleanJsonSchema {
  readonly type: "boolean";
  readonly description?: string;
}

export interface NullJsonSchema {
  readonly type: "null";
  readonly description?: string;
}

interface AgentToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: SupportedJsonSchema;
  readonly outputSchema: SupportedJsonSchema;
}

export function generateTypes(req: TypeGenerationRequest): string {
  const tools = req.tools.map(toAgentToolDefinition);
  const methods = tools.map(printTool);

  return [
    `interface Console {`,
    `  debug(...values: unknown[]): void;`,
    `  error(...values: unknown[]): void;`,
    `  info(...values: unknown[]): void;`,
    `  log(...values: unknown[]): void;`,
    `  warn(...values: unknown[]): void;`,
    `}`,
    ``,
    `declare const console: Console;`,
    ``,
    `interface Tools {`,
    joinBlocks(methods),
    `}`,
    ``,
    ...printJSDoc("", [
      "The object supplied by the code-mode runner when it invokes your program.",
    ]),
    `interface AgentProgramScope {`,
    `  readonly codemode: Tools;`,
    `}`,
    ``,
    ...printJSDoc("", agentProgramDescriptionLines),
    `type AgentProgram = (scope: AgentProgramScope) => Promise<void>;`,
    "",
  ].join("\n");
}

const agentProgramDescriptionLines = [
  "Code submitted to a code-mode runner must be a single async function expression assignable to this type.",
  "",
  "Submit only the function expression as the code string. Do not include these declarations, markdown fences, static imports, exports, or wrapper variables.",
  "",
  "The runner calls the function with `{ codemode }`. Use `codemode.<toolName>(input)` to call the tools declared above, await returned promises, and return nothing when complete.",
  "",
  "If you need modules supplied by the runtime environment, use dynamic `await import(\"module-name\")` inside the async function.",
  "",
  "Example shape:",
  "async ({ codemode }) => {",
  "  const result = await codemode.someTool({ key: \"value\" });",
  "  console.log(result);",
  "}",
] as const;

function toAgentToolDefinition(tool: ExecutableToolDefinition): AgentToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: convertSchema(tool.inputSchema, "input", `tool ${tool.name} inputSchema`),
    outputSchema: convertSchema(tool.outputSchema, "output", `tool ${tool.name} outputSchema`),
  };
}

function convertSchema(
  schema: ToolSchema<any, any>,
  direction: "input" | "output",
  context: string,
): SupportedJsonSchema {
  let converted: Record<string, unknown>;

  try {
    converted = schema["~standard"].jsonSchema[direction]({
      target: "draft-2020-12",
    });
  } catch (error) {
    throw new Error(
      `Code-mode could not convert ${context} to JSON Schema: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  return assertSupportedSchema(converted, context);
}

function assertToolSchema(value: unknown, context: string): asserts value is ToolSchema {
  assertRecord(value, context);
  const standard = value["~standard"];
  assertRecord(standard, `${context}.~standard`);

  if (standard.version !== 1) {
    throw new Error(`Code-mode schema ${context}.~standard.version must be 1`);
  }
  assertNonEmptyString(standard.vendor, `${context}.~standard.vendor`);
  if (typeof standard.validate !== "function") {
    throw new Error(`Code-mode schema ${context}.~standard.validate must be a function`);
  }

  const jsonSchema = standard.jsonSchema;
  assertRecord(jsonSchema, `${context}.~standard.jsonSchema`);
  if (typeof jsonSchema.input !== "function" || typeof jsonSchema.output !== "function") {
    throw new Error(
      `Code-mode schema ${context}.~standard.jsonSchema must provide input() and output()`,
    );
  }
}

function assertSupportedSchema(schema: unknown, context: string): SupportedJsonSchema {
  assertRecord(schema, context);

  if (typeof schema.type !== "string") {
    throw new Error(`Code-mode schema ${context} type must be a string`);
  }
  optionalNonEmptyString(schema.description, `${context}.description`);

  switch (schema.type) {
    case "object":
      assertObjectSchema(schema, context);
      return schema as unknown as ObjectJsonSchema;
    case "array":
      assertSupportedSchema(schema.items, `${context}.items`);
      return schema as unknown as ArrayJsonSchema;
    case "string":
      if (schema.format !== undefined && typeof schema.format !== "string") {
        throw new Error(`Code-mode schema ${context}.format must be a string`);
      }
      return schema as unknown as StringJsonSchema;
    case "number":
      return schema as unknown as NumberJsonSchema;
    case "integer":
      return schema as unknown as IntegerJsonSchema;
    case "boolean":
      return schema as unknown as BooleanJsonSchema;
    case "null":
      return schema as unknown as NullJsonSchema;
    default:
      throw new Error(`Code-mode schema ${context} uses unsupported type: ${schema.type}`);
  }
}

function assertObjectSchema(schema: Record<string, unknown>, context: string): void {
  if (!isRecord(schema.properties)) {
    throw new Error(`Code-mode schema ${context}.properties must be an object`);
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    throw new Error(`Code-mode schema ${context}.required must be an array`);
  }
  if (schema.additionalProperties !== false) {
    throw new Error(
      `Code-mode schema ${context}.additionalProperties must be false`,
    );
  }

  const propertyNames = new Set(Object.keys(schema.properties));
  const requiredNames = new Set<string>();
  for (const required of schema.required ?? []) {
    if (typeof required !== "string") {
      throw new Error(`Code-mode schema ${context}.required entries must be strings`);
    }
    if (requiredNames.has(required)) {
      throw new Error(`Code-mode schema ${context}.required includes a duplicate property: ${required}`);
    }
    if (!propertyNames.has(required)) {
      throw new Error(`Code-mode schema ${context}.required property is not declared: ${required}`);
    }
    requiredNames.add(required);
  }

  for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
    assertSupportedSchema(propertySchema, `${context}.properties.${propertyName}`);
  }
}

function printTool(tool: AgentToolDefinition): string {
  const inputType = printType(tool.inputSchema, "  ");
  const outputType = printType(tool.outputSchema, "  ");
  return [
    ...printJSDoc("  ", toolDescriptionLines(tool)),
    `  ${tool.name}(input: ${inputType}): Promise<${outputType}>;`,
  ].join("\n");
}

function toolDescriptionLines(tool: AgentToolDefinition): readonly string[] {
  const lines = [tool.description];
  if (tool.inputSchema.description !== undefined) {
    lines.push("", `@param input ${tool.inputSchema.description}`);
  }
  if (tool.outputSchema.description !== undefined) {
    if (lines.at(-1) !== "" && !lines.at(-1)?.startsWith("@param ")) {
      lines.push("");
    }
    lines.push(`@returns ${tool.outputSchema.description}`);
  }
  return lines;
}

function printType(schema: SupportedJsonSchema, indent: string): string {
  switch (schema.type) {
    case "object":
      return printObjectType(schema, indent);
    case "array":
      return `ReadonlyArray<${printType(schema.items, indent)}>`;
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
  }
}

function printObjectType(schema: ObjectJsonSchema, indent: string): string {
  const propertyBlocks: string[] = [];
  const required = new Set(schema.required ?? []);
  const propertyIndent = `${indent}  `;
  for (const [name, property] of Object.entries(schema.properties)) {
    propertyBlocks.push([
      ...printJSDoc(propertyIndent, propertyDescriptionLines(property)),
      `${propertyIndent}readonly ${printPropertyName(name)}${required.has(name) ? "" : "?"}: ${printType(property, propertyIndent)};`,
    ].join("\n"));
  }
  return propertyBlocks.length === 0
    ? "Record<string, never>"
    : `{\n${joinBlocks(propertyBlocks)}\n${indent}}`;
}

function propertyDescriptionLines(schema: SupportedJsonSchema): readonly string[] {
  const lines: string[] = [];
  if (schema.description !== undefined) {
    lines.push(schema.description);
  }
  if (schema.type === "string" && schema.format !== undefined) {
    if (lines.length > 0) lines.push("");
    lines.push(`@format ${schema.format}`);
  }
  if (schema.type === "array" && schema.items.description !== undefined) {
    if (lines.length > 0) lines.push("");
    lines.push(`Items: ${schema.items.description}`);
  }
  return lines;
}

function printPropertyName(name: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(name) ? name : JSON.stringify(name);
}

function printJSDoc(indent: string, lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  if (lines.length === 1) return [`${indent}/** ${escapeJSDoc(lines[0] ?? "")} */`];
  return [
    `${indent}/**`,
    ...lines.map((line) => line === "" ? `${indent} *` : `${indent} * ${escapeJSDoc(line)}`),
    `${indent} */`,
  ];
}

function joinBlocks(blocks: readonly string[]): string {
  return blocks.join("\n\n");
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[$A-Z_a-z][$\w]*$/.test(value)) {
    throw new Error(`Code-mode ${label} must be a valid JavaScript identifier: ${String(value)}`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Code-mode ${label} must be a non-empty string`);
  }
}

function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  assertNonEmptyString(value, label);
  return value;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Code-mode ${label} must be an object`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeJSDoc(value: string): string {
  return value.replaceAll("*/", "*\\/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
