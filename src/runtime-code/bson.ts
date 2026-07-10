import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

export const bsonRuntimeSource = readFileSync(
  resolve(dirname(require.resolve("bson")), "bson.bundle.js"),
  "utf8",
).replace(/\n\/\/# sourceMappingURL=.*$/u, "");
