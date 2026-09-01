/**
 * Convention memory — store-backed repository convention storage.
 *
 * After a successful factory run, the workflow extracts conventions the
 * agents discovered. Before the next run, those conventions are injected
 * into the analyst and implementer context so the factory improves over time.
 */
import { factoryStore } from "#factory/store";

const CONVENTIONS_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MAX_CONVENTIONS_CHARS = 2_000;

export async function getConventions(
	repository: string,
): Promise<string | null> {
	return factoryStore().knowledge.get(
		"repository-conventions",
		repository.toLowerCase(),
		CONVENTIONS_TTL_SECONDS,
	);
}

export async function putConventions(
	repository: string,
	conventions: string,
): Promise<void> {
	const truncated = conventions.slice(0, MAX_CONVENTIONS_CHARS);
	await factoryStore().knowledge.put(
		"repository-conventions",
		repository.toLowerCase(),
		truncated,
		CONVENTIONS_TTL_SECONDS,
	);
}

/**
 * Merge new conventions with existing ones, deduplicating by line.
 * Keeps the most recent entries and stays under the character limit.
 */
export async function appendConventions(
	repository: string,
	newConventions: string,
): Promise<void> {
	const newLines = newConventions
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

	if (newLines.length === 0) return;

	await factoryStore().knowledge.appendLines(
		"repository-conventions",
		repository.toLowerCase(),
		newLines,
		{
			maxChars: MAX_CONVENTIONS_CHARS,
			ttlSeconds: CONVENTIONS_TTL_SECONDS,
		},
	);
}
