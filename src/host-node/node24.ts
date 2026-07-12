import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";

import type { TypeDefinitionFile } from "../core/environment.ts";

const require = createRequire(import.meta.url);

let cachedNode24TypeDefinitions:
  | Promise<readonly TypeDefinitionFile[]>
  | undefined;

export function readNode24TypeDefinitions(): Promise<
  readonly TypeDefinitionFile[]
> {
  cachedNode24TypeDefinitions ??= readNode24TypeDefinitionsInner();
  return cachedNode24TypeDefinitions;
}

async function readNode24TypeDefinitionsInner(): Promise<
  readonly TypeDefinitionFile[]
> {
  const nodeTypesPackage = require.resolve("@types/node/package.json");
  const nodeTypesRoot = dirname(nodeTypesPackage);
  const nodeTypesRequire = createRequire(nodeTypesPackage);
  const undiciTypesRoot = dirname(
    nodeTypesRequire.resolve("undici-types/package.json"),
  );

  return [
    ...(await readTypeDefinitionPackage({
      diskRoot: nodeTypesRoot,
      virtualRoot: "node_modules/@types/node",
    })),
    ...(await readTypeDefinitionPackage({
      diskRoot: undiciTypesRoot,
      virtualRoot: "node_modules/undici-types",
    })),
  ];
}

interface ReadTypeDefinitionPackageRequest {
  readonly diskRoot: string;
  readonly virtualRoot: string;
}

async function readTypeDefinitionPackage(
  req: ReadTypeDefinitionPackageRequest,
): Promise<readonly TypeDefinitionFile[]> {
  const files: TypeDefinitionFile[] = [];

  for (const diskPath of await listTypeDefinitionFiles(req.diskRoot)) {
    const relativePath = relative(req.diskRoot, diskPath).split(sep).join("/");
    if (/^ts\d+(?:\.|\/)/.test(relativePath)) {
      continue;
    }
    files.push({
      path: `${req.virtualRoot}/${relativePath}`,
      contents: await readFile(diskPath, "utf8"),
    });
  }

  return files;
}

async function listTypeDefinitionFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, {
    recursive: true,
    withFileTypes: true,
  });
  const files: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (entry.name !== "package.json" && !entry.name.endsWith(".d.ts")) {
      continue;
    }

    files.push(join(entry.parentPath, entry.name));
  }

  return files.sort();
}
