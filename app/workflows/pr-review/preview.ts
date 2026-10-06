import { target } from "../../config/index.js";
import type { PreviewLocator, PreviewStatus } from "../../preview/index.js";
import { RenderPreviewLocator } from "../../preview/index.js";

const POLL_INTERVAL_MS = 15_000;
const MAX_WAIT_MS = 20 * 60 * 1_000;

export interface PreviewResult {
	status: PreviewStatus;
	skippedReason?: string;
}

/**
 * Poll for a preview deploy at headSha, up to 20 minutes.
 * Uses the Render API locator by default.
 */
export async function waitForPreview(opts: {
	headSha: string;
	prNumber: number;
	locator?: PreviewLocator;
}): Promise<PreviewResult> {
	const repo = target();
	if (!repo.preview) {
		return {
			status: { state: "not_configured" },
			skippedReason: "No preview environment configured",
		};
	}

	const apiKey = process.env.RENDER_API_KEY?.trim();
	if (!apiKey) {
		return {
			status: { state: "not_configured" },
			skippedReason: "RENDER_API_KEY not set; cannot poll preview status",
		};
	}

	const locator = opts.locator ?? new RenderPreviewLocator(apiKey);
	const serviceName = repo.preview.serviceName;
	const deadline = Date.now() + MAX_WAIT_MS;

	let last: PreviewStatus = { state: "pending" };
	while (Date.now() < deadline) {
		last = await locator.locate({
			serviceName,
			headSha: opts.headSha,
			prNumber: opts.prNumber,
		});

		if (last.state === "live" || last.state === "failed") {
			return { status: last };
		}

		await sleep(POLL_INTERVAL_MS);
	}

	return {
		status: last,
		skippedReason: `Preview did not become live within 20 minutes. Last: ${last.state === "pending" ? last.detail : "pending"}`,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
