import type { SpecialistFinding } from "../contracts/index.js";
import type { UxResult } from "../contracts/ux.js";
import type { CommandResult } from "../git/types.js";
import type { PreviewStatus } from "../preview/types.js";
import { redactSecrets } from "../policy/index.js";

interface ReviewBodyInput {
	runId: string;
	riskTier: string;
	summary: string;
	verificationResults: readonly CommandResult[];
	specialistFindings: ReadonlyMap<string, readonly SpecialistFinding[]>;
	uxResults: readonly UxResult[];
	previewStatus: PreviewStatus;
	localDevSkipped?: string;
	previewSkipped?: string;
}

export function reviewBody(input: ReviewBodyInput): string {
	const sections: string[] = [];

	sections.push(`## 🏭 Factory Review\n`);
	sections.push(`**Risk tier:** ${input.riskTier}\n`);
	sections.push(redactSecrets(input.summary));

	sections.push(verificationTable(input.verificationResults));

	for (const [specialist, findings] of input.specialistFindings) {
		sections.push(specialistSection(specialist, findings));
	}

	if (input.uxResults.length > 0) {
		sections.push(uxSection(input.uxResults));
	}

	sections.push(previewSection(input.previewStatus, input.previewSkipped));

	if (input.localDevSkipped) {
		sections.push(
			`### Local dev\n\nSkipped: ${redactSecrets(input.localDevSkipped)}`,
		);
	}

	sections.push(`\n\n<!-- render-factory:review run=${input.runId} -->`);

	return sections.join("\n\n");
}

function verificationTable(results: readonly CommandResult[]): string {
	if (results.length === 0)
		return "### Verification\n\nNo verification commands configured.";

	const rows = results.map((r) => {
		const icon = r.exitCode === 0 ? "✅" : "❌";
		const dur = r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : "—";
		return `| ${icon} | \`${escMd(r.command)}\` | ${r.exitCode} | ${dur} |`;
	});

	return [
		"### Verification",
		"",
		"| | Command | Exit | Duration |",
		"|---|---|---|---|",
		...rows,
	].join("\n");
}

function specialistSection(
	name: string,
	findings: readonly SpecialistFinding[],
): string {
	if (findings.length === 0) {
		return `### ${capitalize(name)}\n\nNo findings.`;
	}
	const items = findings.map(
		(f) =>
			`- **${f.severity.toUpperCase()}** (${f.confidence}%) \`${f.path}:${f.line}\` — ${f.title}\n  ${redactSecrets(f.body)}`,
	);
	return `### ${capitalize(name)}\n\n${items.join("\n")}`;
}

function uxSection(results: readonly UxResult[]): string {
	const rows = results.map((r) => {
		const icon =
			r.verdict === "pass" ? "✅" : r.verdict === "fail" ? "❌" : "❓";
		const screenshots =
			r.screenshotArtifactIds.length > 0
				? r.screenshotArtifactIds.map((id) => `![screenshot](${id})`).join(" ")
				: "";
		return `| ${icon} | ${r.criterionId ?? "—"} | ${r.verdict} | ${redactSecrets(r.observations)} | ${screenshots} |`;
	});

	return [
		"### UX testing",
		"",
		"| | Criterion | Verdict | Observations | Screenshots |",
		"|---|---|---|---|---|",
		...rows,
	].join("\n");
}

function previewSection(status: PreviewStatus, skipped?: string): string {
	if (skipped) {
		return `### Preview\n\nSkipped: ${redactSecrets(skipped)}`;
	}
	switch (status.state) {
		case "not_configured":
			return "### Preview\n\nNo preview environment configured.";
		case "live":
			return `### Preview\n\n✅ Live at ${status.url}`;
		case "pending":
			return `### Preview\n\n⏳ ${status.detail ?? "Waiting for deploy"}`;
		case "failed":
			return `### Preview\n\n❌ ${status.detail}`;
	}
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function escMd(s: string): string {
	return s.replace(/[|`]/g, "\\$&");
}
