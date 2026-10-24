import { z } from "zod";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const Severity = z.enum(SEVERITIES);

export const ReviewComment = z.object({
	file: z.string().min(1).describe("Repository-relative path of a file the pull request changes."),
	line: z.number().int().min(1).describe("Line number in the new version of the file."),
	severity: Severity,
	title: z.string().min(1).max(200),
	body: z.string().min(1).max(4000),
});

/** The PR reviewer's submission. It summarizes and assesses risk; it never approves or requests changes. */
export const Review = z.object({
	summary: z.string().min(1).max(8000).describe("Markdown overview of the review, including findings that don't fit an inline comment."),
	riskTier: z.enum(["trivial", "low", "medium", "high"]).describe("The overall assessment."),
	comments: z.array(ReviewComment).max(50).describe("Actionable inline comments, most important first."),
});

export type Severity = z.infer<typeof Severity>;
export type ReviewComment = z.infer<typeof ReviewComment>;
export type Review = z.infer<typeof Review>;
