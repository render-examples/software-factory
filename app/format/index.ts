/**
 * Text that crosses the boundary between GitHub and the models.
 *
 * Inbound: the issue and its comments become one bounded work item.
 * Outbound: results become issue comments and a pull request body.
 */
export {
	changesRequestedComment,
	clarificationComment,
	draftPrComment,
	noChangesComment,
	verifyFailedComment,
} from "./comments.js";
export {
	pullRequestBody,
	reviewerSection,
	reviewSummary,
} from "./review.js";
export { workItem } from "./work-item.js";
