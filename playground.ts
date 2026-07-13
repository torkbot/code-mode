import { HostNodeRuntime } from "./src/host-node/index.ts";
import { createClient, createToolbox, defineTool } from "./src/index.ts";
import { testSchema } from "./src/testing/schema.ts";

async function main() {
  const listFlights = defineTool(
    "listFlights",
    {
      description: "List air flights matching a set of criteria.",
      inputSchema: testSchema({
        type: "object",
        properties: {
          source: { type: "string", description: "The source airport code." },
          dest: {
            type: "string",
            description: "The destination airport code.",
          },
          departureDate: {
            type: "string",
            description: "The date of the departure.",
            format: "date",
          },
          returnDate: {
            type: "string",
            description: "The date of the return.",
            format: "date",
          },
        },
        required: ["source", "dest", "departureDate", "returnDate"],
        additionalProperties: false,
      } as const),
      outputSchema: testSchema({
        type: "object",
        properties: {
          flights: {
            type: "array",
            items: {
              type: "object",
              properties: { code: { type: "string" } },
              required: ["code"],
              additionalProperties: false,
            },
          },
        },
        required: ["flights"],
        additionalProperties: false,
      } as const),
    },
    async (_ctx, query) => {
      console.log(query);
      return {
        flights: [],
      };
    },
  );
  const toolbox = createToolbox([listFlights]);

  const runtime = new HostNodeRuntime(process.execPath);

  const client = createClient({
    runtime,
    toolbox,
  });

  console.log(toolbox.typeDefinitions);

  const source = `async ({ codemode }) => {
    await codemode.listFlights({
      source: "YYZ",
      dest: "LHR",
      departureDate: "5",
      returnDate: "2026-07-08",
    });
  }`;

  console.dir(await client.validate(source, AbortSignal.timeout(5_000)));

  const outcome = await client.run(source, {
    signal: AbortSignal.timeout(5_000),
  });
  if (outcome.kind === "program-failed" && outcome.error.details !== null) {
    console.dir(outcome.error.details.report);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
