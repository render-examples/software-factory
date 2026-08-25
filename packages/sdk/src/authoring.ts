import type { ToolSource, DefineToolSpec, DefineMcpSpec, Hook } from "@render-factory/engine";
import { defineTool as implDefineTool, defineMcpSource as implDefineMcpSource } from "@render-factory/engine";

export function defineTool(spec: DefineToolSpec): ToolSource {
  return implDefineTool(spec);
}

export function defineMcpSource(spec: DefineMcpSpec): ToolSource {
  return implDefineMcpSource(spec);
}

export function defineHook(spec: Hook): Hook {
  return spec;
}
