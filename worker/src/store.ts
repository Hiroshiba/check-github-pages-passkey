import {
  type DeploymentRequestView,
  deploymentRequestViewSchema,
} from "../../shared/deployment";
import { HttpError } from "./errors";
import {
  storedDeploymentRequestSchema,
  type DeploymentDecision,
  type StoredDeploymentRequest,
} from "./schemas";

const KEY_PREFIX = "deployment:";
const MAXIMUM_LIST_ITEMS = 50;
const RECORD_EXPIRATION_SECONDS = 31 * 24 * 60 * 60;

function requestKey(runId: number, attempt: number): string {
  return `${KEY_PREFIX}${runId.toString()}:${attempt.toString()}`;
}

function parseStoredRequest(
  value: string,
  key: string,
): StoredDeploymentRequest {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(value);
  } catch (error) {
    throw new HttpError(`KV の承認要求 ${key} を解析できません`, 500, {
      cause: error,
    });
  }

  const parsed = storedDeploymentRequestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new HttpError(`KV の承認要求 ${key} が不正です`, 500, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function sameImmutableRequest(
  first: StoredDeploymentRequest,
  second: StoredDeploymentRequest,
): boolean {
  return (
    first.attempt === second.attempt &&
    first.callbackUrl === second.callbackUrl &&
    first.deploymentId === second.deploymentId &&
    first.environment === second.environment &&
    first.installationId === second.installationId &&
    first.repository === second.repository &&
    first.repositoryId === second.repositoryId &&
    first.runId === second.runId &&
    first.runUrl === second.runUrl &&
    first.sourceSha === second.sourceSha &&
    first.workflowPath === second.workflowPath &&
    first.workflowRef === second.workflowRef &&
    first.workflowSha === second.workflowSha
  );
}

function toView(request: StoredDeploymentRequest): DeploymentRequestView {
  const base = {
    attempt: request.attempt,
    environment: request.environment,
    repository: request.repository,
    requestedAt: request.requestedAt,
    runId: request.runId,
    runUrl: request.runUrl,
    sourceSha: request.sourceSha,
    workflowPath: request.workflowPath,
    workflowRef: request.workflowRef,
    workflowSha: request.workflowSha,
  };

  const view: unknown =
    request.status === "pending"
      ? { ...base, status: request.status }
      : {
          ...base,
          decidedAt: request.decidedAt,
          status: request.status,
        };
  return deploymentRequestViewSchema.parse(view);
}

/** 新しい承認要求を保存し、再配信では既存状態を維持する。 */
export async function storePendingRequest(
  namespace: KVNamespace,
  request: StoredDeploymentRequest,
): Promise<void> {
  if (request.status !== "pending") {
    throw new HttpError("未処理ではない要求を新規保存できません", 500, {});
  }

  const key = requestKey(request.runId, request.attempt);
  const existingValue = await namespace.get(key);
  if (existingValue != null) {
    const existing = parseStoredRequest(existingValue, key);
    if (!sameImmutableRequest(existing, request)) {
      throw new HttpError(
        "同じ Workflow run に異なる承認要求があります",
        409,
        {},
      );
    }
    return;
  }

  await namespace.put(key, JSON.stringify(request), {
    expirationTtl: RECORD_EXPIRATION_SECONDS,
  });
}

/** run ID と試行回数から承認要求を取得する。 */
export async function getStoredRequest(
  namespace: KVNamespace,
  runId: number,
  attempt: number,
): Promise<StoredDeploymentRequest> {
  const key = requestKey(runId, attempt);
  const value = await namespace.get(key);
  if (value == null) {
    throw new HttpError("承認要求が見つかりません", 404, {});
  }
  return parseStoredRequest(value, key);
}

/** 保存済み承認要求を新しい順で取得する。 */
export async function listStoredRequests(
  namespace: KVNamespace,
): Promise<DeploymentRequestView[]> {
  const result = await namespace.list({
    limit: MAXIMUM_LIST_ITEMS,
    prefix: KEY_PREFIX,
  });
  if (!result.list_complete) {
    throw new HttpError(
      `承認要求が ${MAXIMUM_LIST_ITEMS.toString()} 件を超えています`,
      500,
      {},
    );
  }

  const requests = await Promise.all(
    result.keys.map(async ({ name }) => {
      const value = await namespace.get(name);
      if (value == null) {
        throw new HttpError(`KV の承認要求 ${name} が消失しました`, 500, {});
      }
      return parseStoredRequest(value, name);
    }),
  );

  return requests
    .sort((first, second) =>
      second.requestedAt.localeCompare(first.requestedAt),
    )
    .map(toView);
}

/** 承認要求を処理済みに更新する。 */
export async function storeDecision(
  namespace: KVNamespace,
  request: StoredDeploymentRequest,
  decision: DeploymentDecision,
  decidedAt: string,
): Promise<void> {
  if (request.status !== "pending") {
    throw new HttpError("承認要求はすでに処理済みです", 409, {});
  }

  const decidedRequest = storedDeploymentRequestSchema.parse({
    ...request,
    decidedAt,
    status: decision,
  });
  await namespace.put(
    requestKey(request.runId, request.attempt),
    JSON.stringify(decidedRequest),
    { expirationTtl: RECORD_EXPIRATION_SECONDS },
  );
}
