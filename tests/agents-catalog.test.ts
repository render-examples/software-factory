import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	type Agent,
	correctnessReviewer,
	implementer,
	implementerVars,
	performanceReviewer,
	renderPrompt,
	runAgent,
	securityReviewer,
	selfReview,
	selfReviewVars,
	specialists,
	specialistVars,
	specWriter,
	specWriterVars,
	synthesizer,
	synthesizerVars,
	testsReviewer,
	triage,
	triageVars,
	verifyCommandsVar,
} from "../app/agents/index.js";
import { testing } from "../app/agents/run.js";
import { renderReview } from "../app/format/index.js";
import { checkSubmission, outputSchemaProblem } from "../app/runner/submit.js";
import { call, SUBMIT, say } from "./helpers/runner.js";

vi.mock("../app/events/index.js", () => ({ emit: vi.fn(async () => {}) }));

const spec = {
	title: "Add a dark mode toggle",
	summary: "Let users switch the site to a dark theme.",
	problem: "The site is bright at night.",
	goals: ["A toggle in the header"],
	nonGoals: ["Per-page themes"],
	acceptanceCriteria: [{ id: "AC-1", text: "Clicking the toggle switches the theme", verification: "automated" }],
	approach: "Add a ThemeToggle component in src/components and a CSS variable set.",
	affectedAreas: [{ path: "src/components/ThemeToggle.tsx", change: "new file" }],
	testPlan: "Unit test the toggle in src/components/ThemeToggle.test.tsx.",
	risks: [],
	assumptions: ["The preference is stored in localStorage"],
	openQuestions: [],
};
const finding = {
	file: "src/db.ts",
	line: 12,
	severity: "high",
	confidence: 80,
	title: "SQL built from user input",
	body: "Use a parameterized query.",
	evidence: "db.query(\"select * from users where id = \" + id)",
};

interface CatalogEntry {
	agent: Agent;
	vars: readonly string[];
	model: "small" | "medium" | "large";
	tools: readonly string[];
	maxTurns: number;
	sample: Record<string, unknown>;
}

const READ_ONLY = ["read", "ls", "bash"];
const specialistSample = { findings: [finding], summary: "Checked the query paths." };
/** The pinned catalog: widening an agent's tools or changing its model is a deliberate diff here. */
const catalog: CatalogEntry[] = [
	{
		agent: triage,
		vars: triageVars,
		model: "medium",
		tools: READ_ONLY,
		maxTurns: 40,
		sample: { decision: "draft", questions: [], rationale: "Clear request.", findings: "React app.", relevantPaths: ["src/App.tsx"] },
	},
	{ agent: specWriter, vars: specWriterVars, model: "large", tools: READ_ONLY, maxTurns: 60, sample: { spec, notes: { findings: "React app.", relevantPaths: [] } } },
	{
		agent: implementer,
		vars: implementerVars,
		model: "large",
		tools: ["read", "ls", "bash", "edit", "write"],
		maxTurns: 150,
		sample: {
			summary: "Added the toggle.",
			filesChanged: ["src/components/ThemeToggle.tsx"],
			verification: [{ command: "npm test", passed: true, notes: "" }],
			followUps: [],
		},
	},
	{ agent: selfReview, vars: selfReviewVars, model: "medium", tools: READ_ONLY, maxTurns: 40, sample: { needsRevision: false, issues: [], notes: [] } },
	{ agent: securityReviewer, vars: specialistVars, model: "medium", tools: READ_ONLY, maxTurns: 60, sample: specialistSample },
	{ agent: correctnessReviewer, vars: specialistVars, model: "medium", tools: READ_ONLY, maxTurns: 60, sample: specialistSample },
	{ agent: performanceReviewer, vars: specialistVars, model: "medium", tools: READ_ONLY, maxTurns: 60, sample: specialistSample },
	{ agent: testsReviewer, vars: specialistVars, model: "medium", tools: READ_ONLY, maxTurns: 60, sample: specialistSample },
	{
		agent: synthesizer,
		vars: synthesizerVars,
		model: "medium",
		tools: [],
		maxTurns: 10,
		sample: {
			summary: "One high-severity issue.",
			riskTier: "medium",
			comments: [{ file: "src/db.ts", line: 12, severity: "high", title: "SQL injection", body: "Parameterize it.", sources: ["security"] }],
		},
	},
];

const placeholders = (prompt: string) => [...new Set([...prompt.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]))].sort();

describe.each(catalog)("agent $agent.id", ({ agent, vars, model, tools, maxTurns, sample }) => {
	it("pins its model, tools, and turn limit", () => {
		expect(agent.model).toBe(model);
		expect(agent.tools).toEqual(tools);
		expect(agent.maxTurns).toBe(maxTurns);
	});

	it("loads its prompt file, whose placeholders are exactly the documented vars", () => {
		expect(existsSync(agent.promptPath)).toBe(true);
		expect(agent.promptPath).toMatch(new RegExp(`/app/agents/${agent.id}\\.md$`));
		expect(placeholders(agent.prompt)).toEqual([...vars].sort());
		const filled = renderPrompt(agent.prompt, Object.fromEntries(vars.map((v) => [v, `<${v}>`])));
		expect(filled).not.toMatch(/\{\{/);
	});

	it("asks for exactly one submit call, without JSON-only or hardcoded-path instructions", () => {
		expect(agent.prompt).toMatch(/call `submit` exactly once/i);
		expect(agent.prompt).not.toMatch(/respond only with json/i);
		expect(agent.prompt).not.toMatch(/checked out at \//);
		if (tools.length > 0) expect(agent.prompt).toContain("working directory");
	});

	it("has an output schema the submit tool accepts, and a sample round-trips", () => {
		const jsonSchema = z.toJSONSchema(agent.output, { io: "input" }) as Record<string, unknown>;
		expect(outputSchemaProblem(jsonSchema)).toBeUndefined();
		expect(jsonSchema.type).toBe("object");
		expect(agent.outputJsonSchema).toEqual(jsonSchema);
		expect(checkSubmission(agent.outputJsonSchema, sample)).toEqual({ ok: true });
		const parsed = agent.output.parse(sample);
		expect(agent.output.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
	});
});

describe("catalog", () => {
	it("gives every agent a unique id and prompt file", () => {
		const ids = catalog.map((e) => e.agent.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(catalog.map((e) => e.agent.promptPath)).size).toBe(ids.length);
	});

	it("keys the specialists by name", () => {
		expect(Object.keys(specialists)).toEqual(["security", "correctness", "performance", "tests"]);
		for (const [name, agent] of Object.entries(specialists)) expect(agent.id).toBe(`${name}-reviewer`);
	});

	it("gives only the implementer write tools; only the synthesizer runs without a sandbox", () => {
		const writers = catalog.filter((e) => e.agent.tools.some((t) => t === "edit" || t === "write")).map((e) => e.agent.id);
		expect(writers).toEqual(["implementer"]);
		expect(catalog.filter((e) => e.agent.tools.length === 0).map((e) => e.agent.id)).toEqual(["synthesizer"]);
	});

	it("formats verify commands for the implementer's prompt", () => {
		expect(verifyCommandsVar(["npm run build", "npm test"])).toBe("- `npm run build`\n- `npm test`");
		expect(verifyCommandsVar(["echo `date`"])).toBe("- `` echo `date` ``");
		expect(verifyCommandsVar([])).toMatch(/none configured/);
	});
});

describe("synthesizer end to end", { timeout: 30_000 }, () => {
	afterEach(() => {
		testing.fauxScript = undefined;
	});

	it("runs in the task through runAgent and its output renders as a COMMENT review", async () => {
		const output = catalog.find((e) => e.agent === synthesizer)?.sample;
		let systemPrompt = "";
		testing.fauxScript = (input) => {
			systemPrompt = input.system_prompt;
			return [say("Merging the findings."), call(SUBMIT, output as Record<string, unknown>)];
		};
		const run = await runAgent(synthesizer, { message: JSON.stringify({ security: specialistSample }), vars: { repo: "acme/web" } }, { traceId: "t-synth" });

		expect(systemPrompt).toContain("for acme/web");
		expect(run.output).toEqual(output);
		const payload = renderReview(run.output);
		expect(payload.event).toBe("COMMENT");
		expect(payload.comments).toEqual([{ path: "src/db.ts", line: 12, side: "RIGHT", body: expect.stringContaining("SQL injection") }]);
	});

	it("rejects submissions that break the schema", async () => {
		const approve = call(SUBMIT, { summary: "x", riskTier: "approve", comments: [] });
		testing.fauxScript = () => [approve, approve, approve];
		await expect(runAgent(synthesizer, { message: "m", vars: { repo: "acme/web" } }, { traceId: "t" })).rejects.toMatchObject({ code: "invalid_submission" });
	});
});
