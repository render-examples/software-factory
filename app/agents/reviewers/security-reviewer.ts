import { md } from "../../runners/md.js";
import { readTools } from "../../tools/index.js";
import type { Agent } from "../types.js";
import { specialistContract } from "./contract.js";

export const securityReviewer: Agent = {
	id: "security-reviewer",
	description: "Reviews the PR for exploitable security vulnerabilities",
	model: "medium",
	tools: readTools,
	prompt: md`
		You are a security reviewer. Examine the diff, the spec, verification
		results, and the checked-out code for exploitable vulnerabilities:
		injection, auth bypass, data exposure, SSRF, path traversal, unsafe
		deserialization, or credential leakage.

		Use read tools to inspect the actual source when the diff is ambiguous.
		Report only actionable findings.

		${specialistContract}
	`,
};
