import { z } from "zod";

export const implementationSchema = z.object({
	summary: z.string().min(1),
});

export const selfReviewSchema = z.object({
	needsRevision: z.boolean(),
	issues: z.array(z.string()),
});

export type Implementation = z.infer<typeof implementationSchema>;
export type SelfReview = z.infer<typeof selfReviewSchema>;
