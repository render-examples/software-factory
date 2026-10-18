import { z } from "zod";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const Severity = z.enum(SEVERITIES);

/** Specialists report only findings at or above this confidence. */
export const MIN_CONFIDENCE = 50;

export const Finding = z.object({
	file: z.string().min(1).describe("Repository-relative path of a file the pull request changes."),
	line: z.number().int().min(1).describe("Line number in the new version of the file (the pull request head)."),
	severity: Severity,
	confidence: z.number().int().min(MIN_CONFIDENCE).max(100).describe("100 = confirmed, 75 = very likely, 50 = plausible."),
	title: z.string().min(1).max(200),
	body: z.string().min(1).max(4000).describe("What is wrong, why it matters, and how to fix it."),
	evidence: z.string().min(1).max(2000).describe("The specific code or behavior that supports the finding."),
});

/** One specialist reviewer's submission. */
export const SpecialistReport = z.object({
	findings: z.array(Finding).max(30),
	summary: z.string().max(2000).describe("One paragraph on what you checked and what you found."),
});

export const ReviewComment = z.object({
	file: z.string().min(1),
	line: z.number().int().min(1).describe("Line number in the new version of the file, from a specialist finding."),
	severity: Severity,
	title: z.string().min(1).max(200),
	body: z.string().min(1).max(4000),
	/** Specialists that reported it, after merging duplicates. */
	sources: z.array(z.string().min(1)).min(1),
});

export const RISK_TIERS = ["trivial", "low", "medium", "high"] as const;

/** The synthesizer's submission. It summarizes and assesses risk; it never approves or requests changes. */
export const Review = z.object({
	summary: z.string().min(1).max(8000).describe("Markdown overview of the review, including findings that don't fit an inline comment."),
	riskTier: z.enum(RISK_TIERS).describe("The overall assessment."),
	comments: z.array(ReviewComment).max(50).describe("Merged, deduplicated inline comments, most important first."),
});

export type Severity = z.infer<typeof Severity>;
export type Finding = z.infer<typeof Finding>;
export type SpecialistReport = z.infer<typeof SpecialistReport>;
export type ReviewComment = z.infer<typeof ReviewComment>;
export type RiskTier = (typeof RISK_TIERS)[number];
export type Review = z.infer<typeof Review>;
