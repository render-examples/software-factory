export type PreviewStatus =
	| { state: "not_configured" }
	| { state: "pending"; detail?: string }
	| { state: "live"; url: string }
	| { state: "failed"; detail: string };

/**
 * Locates a PR's preview deploy on the hosting platform.
 * Implementations are platform-specific.
 */
export interface PreviewLocator {
	/**
	 * Check the current status of a preview deploy for a given commit.
	 * Called repeatedly by the workflow until the preview is live or times out.
	 */
	locate(opts: {
		serviceName: string;
		headSha: string;
		prNumber: number;
	}): Promise<PreviewStatus>;
}
