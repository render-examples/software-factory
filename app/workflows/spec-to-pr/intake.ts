/**
 * Intake stage: load and approve the spec version from run input.
 * If no spec or approval fails, finish the run early.
 */
import { approveVersion, getSpecVersion, getSpec } from "../../store/index.js";
import type { Spec } from "../../contracts/index.js";
import type { SpecVersionRecord, SpecRecord } from "../../store/index.js";

export interface IntakeResult {
	spec: Spec;
	specVersion: SpecVersionRecord;
	specRecord: SpecRecord;
}

export async function loadSpecIntake(
	specId: string | null,
	specVersion: number | null | undefined,
	triggerActorLogin: string,
): Promise<
	| { ok: true; intake: IntakeResult }
	| { ok: false; outcome: string; detail: string }
> {
	if (!specId || specVersion == null) {
		return {
			ok: false,
			outcome: "no_spec",
			detail: "No specification ID or version found in the run input.",
		};
	}

	const version = await getSpecVersion(specId, specVersion);
	if (!version) {
		return {
			ok: false,
			outcome: "no_spec",
			detail: `Spec version ${specVersion} of spec ${specId} does not exist.`,
		};
	}

	const approved = await approveVersion(specId, specVersion, triggerActorLogin);
	if (!approved) {
		return {
			ok: false,
			outcome: "no_spec",
			detail: `Could not approve spec version ${specVersion}: the spec may be superseded or the version may not exist.`,
		};
	}

	const specRecord = await getSpec(specId);
	if (!specRecord) {
		return {
			ok: false,
			outcome: "no_spec",
			detail: `Spec ${specId} not found after approval.`,
		};
	}

	return {
		ok: true,
		intake: {
			spec: version.document as unknown as Spec,
			specVersion: version,
			specRecord,
		},
	};
}
