/**
 * Live evals: replays evals/cases/*.json through the real triage agents and grades what they produce.
 *
 *   npm run eval -- --validate
 *   npm run eval -- --installation 12345 --case underspecified-search
 */
import { closeEvents } from "../app/events/index.js";
import { main } from "./eval/cli.js";

try {
	process.exitCode = await main(process.argv.slice(2));
} finally {
	await closeEvents();
}
