import { z } from "zod";

export const commitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "コミット SHA は40文字の小文字16進数が必要です");

const deploymentViewBaseSchema = z.object({
  attempt: z.number().int().positive(),
  environment: z.string().min(1),
  repository: z.string().min(1),
  requestedAt: z.iso.datetime(),
  runId: z.number().int().positive(),
  runUrl: z.url(),
  sourceSha: commitShaSchema,
  workflowPath: z.string().min(1),
  workflowRef: z.string().min(1),
  workflowSha: commitShaSchema,
});

export const deploymentRequestViewSchema = z.discriminatedUnion("status", [
  deploymentViewBaseSchema.extend({
    status: z.literal("pending"),
  }),
  deploymentViewBaseSchema.extend({
    decidedAt: z.iso.datetime(),
    status: z.enum(["approved", "rejected"]),
  }),
]);

export const deploymentRequestListSchema = z.object({
  requests: z.array(deploymentRequestViewSchema),
});

export type DeploymentRequestView = z.infer<typeof deploymentRequestViewSchema>;
