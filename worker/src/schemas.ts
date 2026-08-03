import { z } from "zod";
import { commitShaSchema } from "../../shared/deployment";
import { HttpError } from "./errors";

const nonPlaceholderSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !value.startsWith("REPLACE_WITH_"),
    "設定値を実際の値へ置き換えてください",
  );

const expectedWorkflowShaSchema = commitShaSchema.refine(
  (value) => !/^0+$/.test(value),
  "production ブランチのコミット SHA を設定してください",
);

export const runtimeConfigurationSchema = z.object({
  ACCESS_AUD: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .refine((value) => !/^0+$/.test(value)),
  ACCESS_TEAM_DOMAIN: z
    .string()
    .regex(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/)
    .refine((value) => !value.includes("replace-with")),
  ALLOWED_ENVIRONMENT: z.literal("github-pages"),
  ALLOWED_REPOSITORY: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  ALLOWED_REPOSITORY_ID: z.coerce.number().int().positive(),
  ALLOWED_WORKFLOW_PATH: z.literal(".github/workflows/deploy-pages.yml"),
  ALLOWED_WORKFLOW_REF: z.literal("refs/heads/production"),
  APPROVER_EMAIL: z.email().transform((value) => value.toLowerCase()),
  EXPECTED_WORKFLOW_SHA: expectedWorkflowShaSchema,
  GITHUB_APP_CLIENT_ID: nonPlaceholderSchema,
});

export const runtimeSecretsSchema = z
  .object({
    DECISION_TOKEN_SECRET: z.string().min(32),
    GITHUB_APP_PRIVATE_KEY: z
      .string()
      .trim()
      .startsWith("-----BEGIN PRIVATE KEY-----")
      .endsWith("-----END PRIVATE KEY-----"),
    GITHUB_WEBHOOK_SECRET: z.string().min(32),
  })
  .refine(
    (value) => value.DECISION_TOKEN_SECRET !== value.GITHUB_WEBHOOK_SECRET,
    {
      message: "決定トークンと Webhook には別の Secret が必要です",
      path: ["DECISION_TOKEN_SECRET"],
    },
  );

const repositorySchema = z.looseObject({
  full_name: z.string().min(1),
  id: z.number().int().positive(),
});

const deploymentSchema = z.looseObject({
  environment: z.string().min(1),
  id: z.number().int().positive(),
  original_environment: z.string().min(1),
  ref: z.string().min(1),
  sha: commitShaSchema,
});

export const deploymentProtectionWebhookSchema = z.looseObject({
  action: z.literal("requested"),
  deployment: deploymentSchema,
  deployment_callback_url: z.url(),
  environment: z.string().min(1),
  event: z.literal("workflow_dispatch"),
  installation: z.looseObject({ id: z.number().int().positive() }),
  ref: z.string().min(1),
  repository: repositorySchema,
  sha: commitShaSchema,
});

export const workflowRunSchema = z.looseObject({
  display_title: z.string().min(1),
  event: z.string().min(1),
  head_branch: z.string().min(1),
  head_sha: commitShaSchema,
  html_url: z.url(),
  id: z.number().int().positive(),
  path: z.string().min(1),
  repository: repositorySchema,
  run_attempt: z.number().int().positive(),
  status: z.string().min(1),
});

export const installationTokenResponseSchema = z.looseObject({
  expires_at: z.iso.datetime(),
  token: z.string().min(1),
});

const storedDeploymentBaseSchema = z.object({
  attempt: z.number().int().positive(),
  callbackUrl: z.url(),
  deliveryId: z.uuid(),
  deploymentId: z.number().int().positive(),
  environment: z.string().min(1),
  installationId: z.number().int().positive(),
  repository: z.string().min(1),
  repositoryId: z.number().int().positive(),
  requestedAt: z.iso.datetime(),
  runId: z.number().int().positive(),
  runUrl: z.url(),
  sourceSha: commitShaSchema,
  workflowPath: z.string().min(1),
  workflowRef: z.string().min(1),
  workflowSha: commitShaSchema,
});

export const storedDeploymentRequestSchema = z.discriminatedUnion("status", [
  storedDeploymentBaseSchema.extend({ status: z.literal("pending") }),
  storedDeploymentBaseSchema.extend({
    decidedAt: z.iso.datetime(),
    status: z.enum(["approved", "rejected"]),
  }),
]);

export const decisionTokenPayloadSchema = z.object({
  attempt: z.number().int().positive(),
  decision: z.enum(["approved", "rejected"]),
  deploymentId: z.number().int().positive(),
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  runId: z.number().int().positive(),
});

export const accessJwtClaimsSchema = z.object({
  email: z.email().transform((value) => value.toLowerCase()),
  sub: z.string().min(1),
});

export type RuntimeConfiguration = z.infer<typeof runtimeConfigurationSchema>;
export type RuntimeSecrets = z.infer<typeof runtimeSecretsSchema>;
export type DeploymentProtectionWebhook = z.infer<
  typeof deploymentProtectionWebhookSchema
>;
export type WorkflowRun = z.infer<typeof workflowRunSchema>;
export type StoredDeploymentRequest = z.infer<
  typeof storedDeploymentRequestSchema
>;
export type DecisionTokenPayload = z.infer<typeof decisionTokenPayloadSchema>;
export type DeploymentDecision = DecisionTokenPayload["decision"];

function parseConfiguration<T>(
  result: z.ZodSafeParseResult<T>,
  message: string,
): T {
  if (!result.success) {
    throw new HttpError(message, 500, { cause: result.error });
  }
  return result.data;
}

/** Worker の非機密設定を検証する。 */
export function parseRuntimeConfiguration(env: unknown): RuntimeConfiguration {
  return parseConfiguration(
    runtimeConfigurationSchema.safeParse(env),
    "Worker の非機密設定が不正です",
  );
}

/** Worker の機密設定を検証する。 */
export function parseRuntimeSecrets(env: unknown): RuntimeSecrets {
  return parseConfiguration(
    runtimeSecretsSchema.safeParse(env),
    "Worker の Secret 設定が不正です",
  );
}
