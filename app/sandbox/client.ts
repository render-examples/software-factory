import { Render } from "@renderinc/sdk";

export type SandboxesClient = InstanceType<
	typeof Render
>["experimental"]["sandboxes"];

let cached: { client: SandboxesClient; ownerId?: `tea-${string}` } | undefined;

/** Lazily built so importing this module never requires credentials. */
export function api(): { client: SandboxesClient; ownerId?: `tea-${string}` } {
	if (!cached) {
		const ownerId = process.env.RENDER_WORKSPACE_ID as
			| `tea-${string}`
			| undefined;
		const render = new Render({
			ownerId,
			// Sandboxes are always real, even when the workflow host runs locally.
			useLocalDev: false,
			baseUrl: "https://api.render.com",
		});
		cached = { client: render.experimental.sandboxes, ownerId };
	}
	return cached;
}
