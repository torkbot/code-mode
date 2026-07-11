import Type from "typebox";
import Schema from "typebox/schema";

export const TelemetryErrorSchema = Type.Object(
  {
    name: Type.String(),
    message: Type.String(),
    stack: Type.Union([Type.String(), Type.Null()]),
    details: Type.Union([
      Type.Object(
        {
          kind: Type.Literal("tool-validation"),
          report: Type.String(),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

export const SerializedConsoleValueSchema = Type.Object(
  {
    format: Type.Literal("flatted"),
    value: Type.String(),
  },
  { additionalProperties: false },
);

export const ProgramLogLevelSchema = Type.Union([
  Type.Literal("debug"),
  Type.Literal("info"),
  Type.Literal("log"),
  Type.Literal("warn"),
  Type.Literal("error"),
]);

export const ProgramTelemetryEventSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("program-started"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("program-log"),
      level: ProgramLogLevelSchema,
      message: Type.String(),
      values: Type.Array(SerializedConsoleValueSchema),
    },
    { additionalProperties: false },
  ),
]);

export const ProgramMessageSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("tool-call"),
      id: Type.String(),
      name: Type.String(),
      input: Type.Unknown(),
      stack: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("telemetry"),
      event: ProgramTelemetryEventSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("program-error"),
      error: TelemetryErrorSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("completed"),
    },
    { additionalProperties: false },
  ),
]);

export const HostMessageSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("tool-result"),
      id: Type.String(),
      result: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("tool-error"),
      id: Type.String(),
      error: TelemetryErrorSchema,
    },
    { additionalProperties: false },
  ),
]);

export type TelemetryErrorWire = Type.Static<typeof TelemetryErrorSchema>;
export type SerializedConsoleValue = Type.Static<
  typeof SerializedConsoleValueSchema
>;
export type ProgramTelemetryEvent = Type.Static<
  typeof ProgramTelemetryEventSchema
>;
export type ProgramMessage = Type.Static<typeof ProgramMessageSchema>;
export type HostMessage = Type.Static<typeof HostMessageSchema>;

const programMessageValidator = Schema.Compile(ProgramMessageSchema);
const hostMessageValidator = Schema.Compile(HostMessageSchema);

export function parseProgramMessage(value: unknown): ProgramMessage {
  return parseProtocolValue(
    "program",
    programMessageValidator,
    value,
  );
}

export function parseHostMessage(value: unknown): HostMessage {
  return parseProtocolValue("host", hostMessageValidator, value);
}

function parseProtocolValue<TValue>(
  direction: "host" | "program",
  validator: ProtocolValidator<TValue>,
  value: unknown,
): TValue {
  if (validator.Check(value)) {
    return value;
  }

  const [, errors] = validator.Errors(value);
  const details = errors.map(formatProtocolValidationError).join("; ");
  throw new Error(`Invalid code-mode ${direction} message: ${details}`);
}

interface ProtocolValidator<TValue> {
  Check(value: unknown): value is TValue;
  Errors(value: unknown): readonly [boolean, readonly ProtocolValidationError[]];
}

interface ProtocolValidationError {
  readonly instancePath: string;
  readonly message: string;
}

function formatProtocolValidationError(
  error: ProtocolValidationError,
): string {
  if (error.instancePath.length === 0) {
    return error.message;
  }

  return `${error.instancePath} ${error.message}`;
}
