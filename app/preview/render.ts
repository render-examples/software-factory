import type { PreviewLocator, PreviewStatus } from "./types.js";

/**
 * Render API preview locator.
 *
 * Strategy:
 * 1. GET /services?name=<serviceName>&type=web_service — find the base service ID.
 * 2. GET /services?type=web_service — iterate to find a service whose name
 *    contains the base service name and appears to be a PR preview
 *    (Render names previews like "<service>-<hash>" or similar).
 * 3. GET /services/{id}/deploys — find a deploy with commit.id matching headSha.
 * 4. If the deploy status is "live", return the service URL.
 *
 * Uncertainties (O-4):
 * - Render's exact naming convention for PR preview services is not documented
 *   in the REST schema. We search by listing all web services and matching by
 *   parentServer or by name prefix. This may miss previews with unusual names.
 * - The deploy.commit.id field is assumed to be the full Git SHA. If Render
 *   stores a short SHA, the match would fail.
 * - If the repository has many services, pagination may be needed.
 *
 * When the locator cannot reliably find the preview, it returns "pending" with
 * a detail string. The workflow treats a timeout as "skip with explanation".
 */
export class RenderPreviewLocator implements PreviewLocator {
	constructor(
		private readonly apiKey: string,
		private readonly apiBase = "https://api.render.com/v1",
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	async locate(opts: {
		serviceName: string;
		headSha: string;
		prNumber: number;
	}): Promise<PreviewStatus> {
		const baseService = await this.findBaseService(opts.serviceName);
		if (!baseService) {
			return {
				state: "failed",
				detail: `Base service "${opts.serviceName}" not found in the Render workspace`,
			};
		}

		const previewService = await this.findPreviewService(
			baseService.id,
			opts.serviceName,
			opts.prNumber,
		);
		if (!previewService) {
			return {
				state: "pending",
				detail: `No preview service found yet for PR #${opts.prNumber} (base: ${opts.serviceName})`,
			};
		}

		const deploy = await this.findDeployForSha(previewService.id, opts.headSha);
		if (!deploy) {
			return {
				state: "pending",
				detail: `Preview service ${previewService.name} exists but no deploy for ${opts.headSha.slice(0, 8)} found yet`,
			};
		}

		if (deploy.status === "live") {
			return { state: "live", url: previewService.url };
		}

		const failedStatuses = new Set([
			"build_failed",
			"update_failed",
			"canceled",
			"pre_deploy_failed",
			"deactivated",
		]);
		if (failedStatuses.has(deploy.status)) {
			return {
				state: "failed",
				detail: `Preview deploy ${deploy.id} is ${deploy.status}`,
			};
		}

		return {
			state: "pending",
			detail: `Deploy ${deploy.id} is ${deploy.status}`,
		};
	}

	private async api<T>(path: string): Promise<T> {
		const res = await this.fetchImpl(`${this.apiBase}${path}`, {
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				Accept: "application/json",
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(
				`Render API ${path} -> ${res.status}: ${text.slice(0, 200)}`,
			);
		}
		return res.json() as Promise<T>;
	}

	private async findBaseService(
		name: string,
	): Promise<{ id: string; url: string } | null> {
		const services = await this.api<
			Array<{
				service: {
					id: string;
					name: string;
					serviceDetails?: { url?: string };
				};
			}>
		>(`/services?name=${encodeURIComponent(name)}&type=web_service&limit=1`);
		if (services.length === 0) return null;
		const svc = services[0].service;
		return { id: svc.id, url: svc.serviceDetails?.url ?? "" };
	}

	private async findPreviewService(
		baseId: string,
		baseName: string,
		_prNumber: number,
	): Promise<{ id: string; name: string; url: string } | null> {
		// Render creates preview services with names related to the base service.
		// Try common patterns: the name contains the base name and PR reference.
		const candidates = await this.api<
			Array<{
				service: {
					id: string;
					name: string;
					serviceDetails?: { url?: string; parentServer?: { id: string } };
				};
			}>
		>(`/services?type=web_service&limit=50`);

		for (const { service: svc } of candidates) {
			const isChild = svc.serviceDetails?.parentServer?.id === baseId;
			const nameMatch = svc.name.startsWith(baseName) && svc.name !== baseName;
			if (isChild || nameMatch) {
				return {
					id: svc.id,
					name: svc.name,
					url: svc.serviceDetails?.url ?? "",
				};
			}
		}
		return null;
	}

	private async findDeployForSha(
		serviceId: string,
		headSha: string,
	): Promise<{ id: string; status: string } | null> {
		const deploys = await this.api<
			Array<{
				deploy: { id: string; status: string; commit?: { id?: string } };
			}>
		>(`/services/${serviceId}/deploys?limit=10`);

		for (const { deploy } of deploys) {
			if (deploy.commit?.id === headSha) {
				return { id: deploy.id, status: deploy.status };
			}
		}
		return null;
	}
}
