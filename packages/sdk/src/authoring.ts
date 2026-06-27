import type { ToolSource, DefineToolSpec, DefineMcpSpec, Hook } from "@render-agents/engine";

export function defineTool(_spec: DefineToolSpec): ToolSource {
  throw new Error("not implemented");
}

export function defineMcpSource(_spec: DefineMcpSpec): ToolSource {
  throw new Error("not implemented");
}

export function defineHook(spec: Hook): Hook {
  return spec;
}
