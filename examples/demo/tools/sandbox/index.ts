import { createSandboxToolSource } from "@render-agents/engine";
import { RenderSandboxProvider } from "@render-agents/sandbox-render";

const provider = new RenderSandboxProvider();
export default createSandboxToolSource({ provider });
