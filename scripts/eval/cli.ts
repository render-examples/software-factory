import { parseArgs } from "node:util";
import { runAgent } from "../../app/agents/index.js";
import { config, requireRepo } from "../../app/config/index.js";
import { emit } from "../../app/events/index.js";
import { openSandbox } from "../../app/sandbox/index.js";
import { CASES_DIR, loadCases, selectCases } from "./case.js";
import { casePlan, summaryTable } from "./report.js";
import { type EvalDeps, runEvals } from "./run.js";

export const USAGE = `Usage: npm run eval -- [options]

Replays eval cases against the real triage agents in a sandbox restored from the repository's snapshot, and grades them.

  --validate            Only validate the case files; no live services. The default when CI is set.
  --live                Run live even when CI is set.
  --case <id>           Run only this case (repeatable).
  --repo <owner/name>   Repository to run against (default: the first repo in factory.config.ts).
  --installation <id>   GitHub App installation id for that repository (or FACTORY_EVAL_INSTALLATION_ID).
  --budget <usd>        Dollars each case may spend (default: limits.perRunUsd).
  -h, --help            Show this help.

Live runs need the Workflows service's env: model keys, RENDER_API_KEY, and the GitHub App credentials.
With DATABASE_URL set, each run records one trace of eval.* and agent.* events.`;

export interface MainDeps extends Partial<Pick<EvalDeps, "openSandbox" | "runAgent" | "emit" | "traceId" | "now">> {
	casesDir?: string;
	env?: NodeJS.ProcessEnv;
	out?: (line: string) => void;
}

/** The eval CLI. Returns the exit code: 0 when every case is valid (and, live, passes), 1 otherwise, 2 on bad usage. */
export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<number> {
	const out = deps.out ?? ((line: string) => console.log(line));
	const env = deps.env ?? process.env;

	let values: ReturnType<typeof parse>;
	try {
		values = parse(argv);
	} catch (error) {
		out(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
		return 2;
	}
	if (values.help) {
		out(USAGE);
		return 0;
	}

	const { cases: all, errors } = await loadCases(deps.casesDir ?? CASES_DIR);
	if (errors.length > 0) {
		out(["Invalid eval cases:", ...errors.map((e) => `  - ${e}`)].join("\n"));
		return 1;
	}
	let cases: typeof all;
	try {
		cases = selectCases(all, values.case ?? []);
	} catch (error) {
		out(error instanceof Error ? error.message : String(error));
		return 2;
	}

	const validateOnly = values.validate || (Boolean(env.CI) && !values.live);
	if (validateOnly) {
		out(casePlan(cases));
		return 0;
	}

	let evalDeps: EvalDeps;
	try {
		evalDeps = {
			repo: requireRepo(values.repo ?? firstRepo(), installationId(values.installation ?? env.FACTORY_EVAL_INSTALLATION_ID)),
			openSandbox: deps.openSandbox ?? openSandbox,
			runAgent: deps.runAgent ?? runAgent,
			emit: deps.emit ?? emit,
			budgetUsd: values.budget === undefined ? config.limits.perRunUsd : positiveUsd(values.budget),
			traceId: deps.traceId,
			now: deps.now,
			log: out,
		};
	} catch (error) {
		out(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
		return 2;
	}
	if (!env.DATABASE_URL?.trim()) out("DATABASE_URL is not set: the run is graded, but no events are recorded.");

	out(`Running ${cases.length} case(s) against ${evalDeps.repo.fullName} at ${evalDeps.repo.config.baseBranch}, $${evalDeps.budgetUsd} each.`);
	const run = await runEvals(cases, evalDeps);
	out(`\n${summaryTable(run)}`);
	return run.failed > 0 ? 1 : 0;
}

function parse(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		options: {
			validate: { type: "boolean", default: false },
			live: { type: "boolean", default: false },
			case: { type: "string", multiple: true },
			repo: { type: "string" },
			installation: { type: "string" },
			budget: { type: "string" },
			help: { type: "boolean", short: "h", default: false },
		},
		strict: true,
		allowPositionals: false,
	}).values;
}

function firstRepo(): string {
	const repo = Object.keys(config.repos)[0];
	if (!repo) throw new Error("factory.config.ts configures no repositories");
	return repo;
}

function installationId(raw: string | undefined): number {
	if (!raw?.trim()) throw new Error("live evals need a GitHub App installation id: pass --installation <id> or set FACTORY_EVAL_INSTALLATION_ID");
	const id = Number(raw);
	if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`invalid installation id ${JSON.stringify(raw)}`);
	return id;
}

function positiveUsd(raw: string): number {
	const usd = Number(raw);
	if (!Number.isFinite(usd) || usd <= 0) throw new Error(`invalid --budget ${JSON.stringify(raw)}: give dollars, such as 2.5`);
	return usd;
}
