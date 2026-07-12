export interface CodeModeEnvironment {
  readonly description: string;
  readonly typeDefinitionFiles: readonly TypeDefinitionFile[];
}

export interface TypeDefinitionFile {
  readonly path: string;
  readonly contents: string;
}
