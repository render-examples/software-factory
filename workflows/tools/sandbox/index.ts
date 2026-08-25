import { createSandboxToolSource } from "@render-factory/engine";
import { RenderSandboxProvider } from "@render-factory/sandbox-render";

const provider = new RenderSandboxProvider();
export default createSandboxToolSource({ provider });
