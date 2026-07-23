import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";

/**
 * Standard Schema validator that can also describe both sides of its optional
 * transformation as Standard JSON Schema.
 */
export type ToolSchema<Input = unknown, Output = Input> =
  & StandardSchemaV1<Input, Output>
  & StandardJSONSchemaV1<Input, Output>;

/** Value accepted before a ToolSchema applies its input transformation. */
export type SchemaInput<Schema extends ToolSchema<any, any>> =
  StandardSchemaV1.InferInput<Schema>;

/** Value produced after a ToolSchema applies its transformation. */
export type SchemaOutput<Schema extends ToolSchema<any, any>> =
  StandardSchemaV1.InferOutput<Schema>;

/** Agent-facing description and schemas for one code-mode tool. */
interface ToolDefinition<
  InputSchema extends ToolSchema<any, any> = ToolSchema<any, any>,
  OutputSchema extends ToolSchema<any, any> = ToolSchema<any, any>,
> {
  /** Concise instructions included in generated agent declarations. */
  readonly description: string;
  /** Schema used to validate and transform program-supplied input. */
  readonly inputSchema: InputSchema;
  /** Schema used to validate and transform handler-supplied output. */
  readonly outputSchema: OutputSchema;
}

/** Per-call host context passed to a tool handler. */
interface ToolExecutionContext {
  /** Aborts when the program execution no longer needs this tool call. */
  readonly signal: AbortSignal;
}

/** Host implementation for one tool definition. */
type ToolHandler<
  InputSchema extends ToolSchema<any, any> = ToolSchema<any, any>,
  OutputSchema extends ToolSchema<any, any> = ToolSchema<any, any>,
> = (
  ctx: ToolExecutionContext,
  input: SchemaOutput<NoInfer<InputSchema>>,
) => Promise<SchemaInput<NoInfer<OutputSchema>>>;

/** Validated tool definition with its registered name and host handler. */
export interface ExecutableToolDefinition<
  Name extends string = string,
  InputSchema extends ToolSchema<any, any> = ToolSchema<any, any>,
  OutputSchema extends ToolSchema<any, any> = ToolSchema<any, any>,
> extends ToolDefinition<InputSchema, OutputSchema> {
  /** JavaScript identifier exposed as `codemode.<name>`. */
  readonly name: Name;
  /** Execute the host tool after input validation and transformation. */
  execute: ToolHandler<InputSchema, OutputSchema>;
  readonly [executableToolDefinitionBrand]: {
    readonly inputSchema: InputSchema;
    readonly outputSchema: OutputSchema;
  };
}

/** Immutable tool collection and its complete agent-facing declarations. */
export interface Toolbox {
  /** Ambient TypeScript declarations supplied to an agent and checker. */
  readonly typeDefinitions: string;
  readonly [toolboxBrand]: true;
}

export type ExecutableToolDefinitions = Readonly<Record<string, ExecutableToolDefinition>>;

interface TypeGenerationRequest {
  readonly tools: readonly ExecutableToolDefinition[];
}

const executableToolDefinitionBrand: unique symbol = Symbol("ExecutableToolDefinition");
const toolboxBrand: unique symbol = Symbol("Toolbox");

interface ToolboxState {
  readonly byName: ExecutableToolDefinitions;
}

const toolboxStates = new WeakMap<Toolbox, ToolboxState>();

/**
 * Define one named tool from Standard Schema definitions and an async host
 * handler. Add the returned definition to createToolbox().
 *
 * @param name JavaScript identifier exposed as `codemode.<name>`.
 * @param definition Agent-facing description plus input and output schemas.
 * @param execute Host handler called after input validation and transformation.
 * @returns An executable definition accepted by createToolbox().
 */
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
    ...definition,
    name,
    execute,
    [executableToolDefinitionBrand]: {
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
    },
  };
}

/**
 * Validate a flat list of uniquely named tools and generate the TypeScript
 * declarations used by code-mode agents.
 *
 * @param tools Complete set of tools to expose on the agent's `codemode` object.
 * @returns An immutable Toolbox for createClient().
 */
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
    if (blockedToolNames.has(tool.name)) {
      throw new Error(`Code-mode tool name is reserved: ${tool.name}`);
    }
    assertNonEmptyString(tool.description, `tool ${tool.name} description`);
    assertToolSchema(tool.inputSchema, `tool ${tool.name} inputSchema`);
    assertToolSchema(tool.outputSchema, `tool ${tool.name} outputSchema`);
    if (typeof tool.execute !== "function") {
      throw new Error(`Code-mode tool ${tool.name} execute must be a function`);
    }

    if (Object.hasOwn(byName, tool.name)) {
      throw new Error(`Code-mode tool names must be unique: ${tool.name}`);
    }

    byName[tool.name] = tool;
  }

  const toolbox: Toolbox = {
    typeDefinitions: generateTypes({ tools: list }),
    [toolboxBrand]: true,
  };
  toolboxStates.set(toolbox, { byName });
  return toolbox;
}

export function getToolboxTools(toolbox: Toolbox): ExecutableToolDefinitions {
  return getToolboxState(toolbox).byName;
}

function getToolboxState(toolbox: Toolbox): ToolboxState {
  const state = toolboxStates.get(toolbox);

  if (state === undefined) {
    throw new Error("Code-mode toolbox must be created with createToolbox");
  }

  return state;
}

type SupportedJsonSchema =
  | ObjectJsonSchema
  | ArrayJsonSchema
  | StringJsonSchema
  | NumberJsonSchema
  | IntegerJsonSchema
  | BooleanJsonSchema
  | NullJsonSchema;

interface ObjectJsonSchema {
  readonly type: "object";
  readonly description?: string;
  readonly properties: Readonly<Record<string, SupportedJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

interface ArrayJsonSchema {
  readonly type: "array";
  readonly description?: string;
  readonly items: SupportedJsonSchema;
}

interface StringJsonSchema {
  readonly type: "string";
  readonly description?: string;
  readonly format?: string;
}

interface NumberJsonSchema {
  readonly type: "number";
  readonly description?: string;
}

interface IntegerJsonSchema {
  readonly type: "integer";
  readonly description?: string;
}

interface BooleanJsonSchema {
  readonly type: "boolean";
  readonly description?: string;
}

interface NullJsonSchema {
  readonly type: "null";
  readonly description?: string;
}

interface AgentToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: SupportedJsonSchema;
  readonly outputSchema: SupportedJsonSchema;
}

function generateTypes(req: TypeGenerationRequest): string {
  const tools = req.tools.map(toAgentToolDefinition);
  const methods = tools.map(printTool);

  return [
    ...printJSDoc("", [
      "Minimal text console supplied to the program by the runtime.",
    ]),
    `interface CodeModeConsole {`,
    ...printJSDoc("  ", ["Emit diagnostic text on stdout."]),
    `  debug(...values: unknown[]): void;`,
    ...printJSDoc("  ", ["Emit error text on stderr."]),
    `  error(...values: unknown[]): void;`,
    ...printJSDoc("  ", ["Emit informational text on stdout."]),
    `  info(...values: unknown[]): void;`,
    ...printJSDoc("  ", ["Emit ordinary text on stdout."]),
    `  log(...values: unknown[]): void;`,
    ...printJSDoc("  ", ["Emit warning text on stderr."]),
    `  warn(...values: unknown[]): void;`,
    `}`,
    ``,
    `type Exact<Expected, Actual> = Actual extends Expected`,
    `  ? Actual extends readonly unknown[]`,
    `    ? Expected extends ReadonlyArray<infer Item>`,
    `      ? ReadonlyArray<Exact<Item, Actual[number]>>`,
    `      : never`,
    `    : Actual extends object`,
    `      ? { readonly [Key in keyof Actual]: Key extends keyof Expected ? Exact<Expected[Key], Actual[Key]> : never }`,
    `      : Actual`,
    `  : Expected;`,
    ``,
    ...printJSDoc("", ["Host tools available to the submitted program."]),
    `interface Tools {`,
    `  readonly constructor?: never;`,
    `  readonly hasOwnProperty?: never;`,
    `  readonly isPrototypeOf?: never;`,
    `  readonly propertyIsEnumerable?: never;`,
    `  readonly toLocaleString?: never;`,
    `  readonly toString?: never;`,
    `  readonly valueOf?: never;`,
    joinBlocks(methods),
    `}`,
    ``,
    ...printJSDoc("", [
      "The object supplied by the code-mode runner when it invokes your program.",
    ]),
    `interface AgentProgramScope {`,
    ...printJSDoc("  ", ["Host tools available to this program."]),
    `  readonly codemode: Tools;`,
    ...printJSDoc("  ", ["The only console whose output the runtime captures."]),
    `  readonly console: CodeModeConsole;`,
    `}`,
    ``,
    ...printJSDoc("", agentProgramDescriptionLines),
    `type AgentProgram = (scope: AgentProgramScope) => unknown;`,
    "",
  ].join("\n");
}

const agentProgramDescriptionLines = [
  "Code submitted to a code-mode runner must be an ECMAScript module and must default-export a function assignable to this type.",
  "",
  "Submit only the module source. Do not include these declarations or markdown fences. Static imports are supported when the runtime can resolve them.",
  "",
  "The runner calls the default export with `{ codemode, console }`, awaits it, and ignores its fulfilled value. Use `codemode.<toolName>(input)` to call the tools declared above.",
  "",
  "Only the `console` passed in the scope is captured as program output. Ambient and imported consoles are outside the output contract.",
  "",
  "Example shape:",
  "import { inspect } from \"node:util\";",
  "",
  "export default async function ({ codemode, console }: AgentProgramScope) {",
  "  const result = await codemode.someTool({ key: \"value\" });",
  "  console.log(inspect(result));",
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

  if (standard["version"] !== 1) {
    throw new Error(`Code-mode schema ${context}.~standard.version must be 1`);
  }
  assertNonEmptyString(standard["vendor"], `${context}.~standard.vendor`);
  if (typeof standard["validate"] !== "function") {
    throw new Error(`Code-mode schema ${context}.~standard.validate must be a function`);
  }

  const jsonSchema = standard["jsonSchema"];
  assertRecord(jsonSchema, `${context}.~standard.jsonSchema`);
  if (
    typeof jsonSchema["input"] !== "function"
    || typeof jsonSchema["output"] !== "function"
  ) {
    throw new Error(
      `Code-mode schema ${context}.~standard.jsonSchema must provide input() and output()`,
    );
  }
}

function assertSupportedSchema(schema: unknown, context: string): SupportedJsonSchema {
  assertRecord(schema, context);

  const type = schema["type"];
  if (typeof type !== "string") {
    throw new Error(`Code-mode schema ${context} type must be a string`);
  }
  optionalNonEmptyString(schema["description"], `${context}.description`);

  switch (type) {
    case "object":
      assertSchemaKeywords(schema, context, [
        "type",
        "description",
        "properties",
        "required",
        "additionalProperties",
      ]);
      assertObjectSchema(schema, context);
      return schema as unknown as ObjectJsonSchema;
    case "array":
      assertSchemaKeywords(schema, context, ["type", "description", "items"]);
      assertSupportedSchema(schema["items"], `${context}.items`);
      return schema as unknown as ArrayJsonSchema;
    case "string":
      assertSchemaKeywords(schema, context, ["type", "description", "format"]);
      if (
        schema["format"] !== undefined
        && typeof schema["format"] !== "string"
      ) {
        throw new Error(`Code-mode schema ${context}.format must be a string`);
      }
      return schema as unknown as StringJsonSchema;
    case "number":
      assertSchemaKeywords(schema, context, ["type", "description"]);
      return schema as unknown as NumberJsonSchema;
    case "integer":
      assertSchemaKeywords(schema, context, ["type", "description"]);
      return schema as unknown as IntegerJsonSchema;
    case "boolean":
      assertSchemaKeywords(schema, context, ["type", "description"]);
      return schema as unknown as BooleanJsonSchema;
    case "null":
      assertSchemaKeywords(schema, context, ["type", "description"]);
      return schema as unknown as NullJsonSchema;
    default:
      throw new Error(`Code-mode schema ${context} uses unsupported type: ${type}`);
  }
}

function assertSchemaKeywords(
  schema: Record<string, unknown>,
  context: string,
  supportedKeywords: readonly string[],
): void {
  const supported = new Set(supportedKeywords);
  for (const keyword of Object.keys(schema)) {
    if (!supported.has(keyword)) {
      throw new Error(
        `Code-mode schema ${context} uses unsupported keyword: ${keyword}`,
      );
    }
  }
}

function assertObjectSchema(schema: Record<string, unknown>, context: string): void {
  const properties = schema["properties"];
  const required = schema["required"];
  if (!isRecord(properties)) {
    throw new Error(`Code-mode schema ${context}.properties must be an object`);
  }
  if (required !== undefined && !Array.isArray(required)) {
    throw new Error(`Code-mode schema ${context}.required must be an array`);
  }
  if (schema["additionalProperties"] !== false) {
    throw new Error(
      `Code-mode schema ${context}.additionalProperties must be false`,
    );
  }

  const propertyNames = new Set(Object.keys(properties));
  const requiredNames = new Set<string>();
  for (const requiredName of required ?? []) {
    if (typeof requiredName !== "string") {
      throw new Error(`Code-mode schema ${context}.required entries must be strings`);
    }
    if (requiredNames.has(requiredName)) {
      throw new Error(`Code-mode schema ${context}.required includes a duplicate property: ${requiredName}`);
    }
    if (!propertyNames.has(requiredName)) {
      throw new Error(`Code-mode schema ${context}.required property is not declared: ${requiredName}`);
    }
    requiredNames.add(requiredName);
  }

  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    assertSupportedSchema(propertySchema, `${context}.properties.${propertyName}`);
  }
}

function printTool(tool: AgentToolDefinition): string {
  const inputType = printType(tool.inputSchema, "  ");
  const outputType = printType(tool.outputSchema, "  ");
  const signature = tool.inputSchema.type === "object" || tool.inputSchema.type === "array"
    ? `  ${tool.name}<const Input extends ${inputType}>(input: Exact<${inputType}, Input>): Promise<${outputType}>;`
    : `  ${tool.name}(input: ${inputType}): Promise<${outputType}>;`;
  return [
    ...printJSDoc("  ", toolDescriptionLines(tool)),
    signature,
  ].join("\n");
}

function toolDescriptionLines(tool: AgentToolDefinition): readonly string[] {
  const lines = [tool.description];
  if (tool.inputSchema.description !== undefined) {
    lines.push("", `@param input ${tool.inputSchema.description}`);
  }
  if (tool.outputSchema.description !== undefined) {
    if (tool.inputSchema.description === undefined) {
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

const reservedWords = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "export", "extends", "false",
  "finally", "for", "function", "if", "import", "in", "instanceof",
  "new", "null", "return", "super", "switch", "this", "throw", "true",
  "try", "typeof", "var", "void", "while", "with", "yield",
]);

const blockedToolNames = new Set([
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "then",
  "toLocaleString",
  "toString",
  "valueOf",
]);

function printJSDoc(indent: string, lines: readonly string[]): string[] {
  const normalizedLines = lines.flatMap((line) => line.split(/\r?\n/));
  if (normalizedLines.length === 0) return [];
  if (normalizedLines.length === 1) {
    return [`${indent}/** ${escapeJSDoc(normalizedLines[0]!)} */`];
  }
  return [
    `${indent}/**`,
    ...normalizedLines.map((line) => (
      line === "" ? `${indent} *` : `${indent} * ${escapeJSDoc(line)}`
    )),
    `${indent} */`,
  ];
}

function joinBlocks(blocks: readonly string[]): string {
  return blocks.join("\n\n");
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string"
    || !/^[$A-Z_a-z][$\w]*$/.test(value)
    || reservedWords.has(value)
  ) {
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
