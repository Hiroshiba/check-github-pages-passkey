import { z } from "zod";
import { commitShaSchema } from "../../shared/deployment";
import { HttpError } from "./errors";
import {
  type DeploymentProtectionWebhook,
  type RuntimeConfiguration,
  type StoredDeploymentRequest,
  type WorkflowRun,
} from "./schemas";

const sourceShaTitleSchema = z
  .string()
  .regex(/^本番デプロイ [0-9a-f]{40}$/)
  .transform((value) => value.slice("本番デプロイ ".length))
  .pipe(commitShaSchema);

function assertPolicy(condition: boolean, message: string): void {
  if (!condition) {
    throw new HttpError(message, 403, {});
  }
}

function productionBranchName(configuration: RuntimeConfiguration): string {
  return configuration.ALLOWED_WORKFLOW_REF.slice("refs/heads/".length);
}

function parseCallbackRunId(
  callbackUrl: string,
  configuration: RuntimeConfiguration,
): number {
  const url = new URL(callbackUrl);
  assertPolicy(
    url.protocol === "https:",
    "GitHub callback URL の通信方式が不正です",
  );
  assertPolicy(
    url.hostname === "api.github.com",
    "GitHub callback URL のホストが不正です",
  );
  assertPolicy(url.port === "", "GitHub callback URL のポートが不正です");
  assertPolicy(
    url.username === "",
    "GitHub callback URL にユーザー名があります",
  );
  assertPolicy(
    url.password === "",
    "GitHub callback URL にパスワードがあります",
  );
  assertPolicy(url.search === "", "GitHub callback URL にクエリがあります");
  assertPolicy(url.hash === "", "GitHub callback URL にフラグメントがあります");

  const prefix = `/repos/${configuration.ALLOWED_REPOSITORY}/actions/runs/`;
  const suffix = "/deployment_protection_rule";
  assertPolicy(
    url.pathname.startsWith(prefix),
    "GitHub callback URL のリポジトリが不正です",
  );
  assertPolicy(
    url.pathname.endsWith(suffix),
    "GitHub callback URL の種類が不正です",
  );

  const runIdText = url.pathname.slice(prefix.length, -suffix.length);
  const parsedRunId = z.coerce.number().int().positive().safeParse(runIdText);
  if (!parsedRunId.success) {
    throw new HttpError("GitHub callback URL の run ID が不正です", 403, {
      cause: parsedRunId.error,
    });
  }
  assertPolicy(
    url.pathname === `${prefix}${parsedRunId.data.toString()}${suffix}`,
    "GitHub callback URL が正規化されていません",
  );
  return parsedRunId.data;
}

/** Webhook の固定デプロイ情報を検証して Workflow run ID を返す。 */
export function validateWebhook(
  webhook: DeploymentProtectionWebhook,
  configuration: RuntimeConfiguration,
): number {
  assertPolicy(
    webhook.repository.id === configuration.ALLOWED_REPOSITORY_ID,
    "Webhook のリポジトリ ID が一致しません",
  );
  assertPolicy(
    webhook.repository.full_name === configuration.ALLOWED_REPOSITORY,
    "Webhook のリポジトリ名が一致しません",
  );
  assertPolicy(
    webhook.environment === configuration.ALLOWED_ENVIRONMENT,
    "Webhook の Environment が一致しません",
  );
  assertPolicy(
    webhook.deployment.environment === configuration.ALLOWED_ENVIRONMENT,
    "Deployment の Environment が一致しません",
  );
  assertPolicy(
    webhook.deployment.original_environment ===
      configuration.ALLOWED_ENVIRONMENT,
    "Deployment の元 Environment が一致しません",
  );
  assertPolicy(
    webhook.deployment.ref === productionBranchName(configuration),
    "Deployment の ref が production ではありません",
  );
  assertPolicy(
    webhook.deployment.sha === configuration.EXPECTED_WORKFLOW_SHA,
    "Deployment の SHA が許可値と一致しません",
  );
  assertPolicy(
    webhook.ref === productionBranchName(configuration) ||
      webhook.ref === configuration.ALLOWED_WORKFLOW_REF,
    "Webhook の ref が production ではありません",
  );
  assertPolicy(
    webhook.sha === configuration.EXPECTED_WORKFLOW_SHA,
    "Webhook の SHA が許可値と一致しません",
  );
  assertPolicy(
    webhook.sha === webhook.deployment.sha,
    "Webhook と Deployment の SHA が一致しません",
  );
  return parseCallbackRunId(webhook.deployment_callback_url, configuration);
}

function validateRun(
  run: WorkflowRun,
  runId: number,
  configuration: RuntimeConfiguration,
): string {
  assertPolicy(run.id === runId, "Workflow run ID が一致しません");
  assertPolicy(
    run.repository.id === configuration.ALLOWED_REPOSITORY_ID,
    "Workflow run のリポジトリ ID が一致しません",
  );
  assertPolicy(
    run.event === "workflow_dispatch",
    "Workflow の起動イベントが不正です",
  );
  assertPolicy(
    run.head_branch === productionBranchName(configuration),
    "Workflow のブランチが production ではありません",
  );
  assertPolicy(
    run.head_sha === configuration.EXPECTED_WORKFLOW_SHA,
    "Workflow のコミット SHA が許可値と一致しません",
  );
  assertPolicy(
    run.path === configuration.ALLOWED_WORKFLOW_PATH,
    "Workflow のパスが許可値と一致しません",
  );
  assertPolicy(
    run.status === "in_progress" || run.status === "waiting",
    "Workflow run は承認待ち状態ではありません",
  );

  const sourceSha = sourceShaTitleSchema.safeParse(run.display_title);
  if (!sourceSha.success) {
    throw new HttpError("Workflow run 名からソース SHA を検証できません", 403, {
      cause: sourceSha.error,
    });
  }
  return sourceSha.data;
}

/** Webhook と Workflow run を固定デプロイ方針に照らして検証する。 */
export function validateWebhookAndRun(
  webhook: DeploymentProtectionWebhook,
  run: WorkflowRun,
  deliveryId: string,
  requestedAt: string,
  configuration: RuntimeConfiguration,
): StoredDeploymentRequest {
  const runId = validateWebhook(webhook, configuration);
  const sourceSha = validateRun(run, runId, configuration);
  assertPolicy(
    run.head_sha === webhook.deployment.sha,
    "Webhook と Workflow run の SHA が一致しません",
  );

  return {
    attempt: run.run_attempt,
    callbackUrl: webhook.deployment_callback_url,
    deliveryId,
    deploymentId: webhook.deployment.id,
    environment: webhook.environment,
    installationId: webhook.installation.id,
    repository: webhook.repository.full_name,
    repositoryId: webhook.repository.id,
    requestedAt,
    runId,
    runUrl: run.html_url,
    sourceSha,
    status: "pending",
    workflowPath: run.path,
    workflowRef: configuration.ALLOWED_WORKFLOW_REF,
    workflowSha: run.head_sha,
  };
}

/** 保存済み要求が現在の Workflow run と一致することを再検証する。 */
export function validateStoredRequestAndRun(
  request: StoredDeploymentRequest,
  run: WorkflowRun,
  configuration: RuntimeConfiguration,
): void {
  assertPolicy(request.status === "pending", "承認要求は処理済みです");
  const sourceSha = validateRun(run, request.runId, configuration);
  assertPolicy(
    run.run_attempt === request.attempt,
    "Workflow run の試行回数が変わりました",
  );
  assertPolicy(
    sourceSha === request.sourceSha,
    "デプロイ元 SHA が変わりました",
  );
  assertPolicy(
    request.repositoryId === configuration.ALLOWED_REPOSITORY_ID,
    "保存済み要求のリポジトリ ID が一致しません",
  );
  assertPolicy(
    request.environment === configuration.ALLOWED_ENVIRONMENT,
    "保存済み要求の Environment が一致しません",
  );
  assertPolicy(
    request.workflowPath === configuration.ALLOWED_WORKFLOW_PATH,
    "保存済み要求の Workflow が一致しません",
  );
  assertPolicy(
    request.workflowRef === configuration.ALLOWED_WORKFLOW_REF,
    "保存済み要求の ref が一致しません",
  );
  assertPolicy(
    request.workflowSha === configuration.EXPECTED_WORKFLOW_SHA,
    "保存済み要求の Workflow SHA が一致しません",
  );
}
