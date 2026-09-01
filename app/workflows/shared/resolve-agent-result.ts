import { isBlobRef, requireBlob } from "#factory/sdk";

export async function resolveAgentResult(result: string): Promise<string> {
	return isBlobRef(result) ? requireBlob(result) : result;
}
