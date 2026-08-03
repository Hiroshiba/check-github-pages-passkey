import { z } from "zod";
import { verifyAccessIdentity } from "./access";
import {
  createDecisionToken,
  verifyDecisionToken,
  verifyWebhookSignature,
} from "./crypto";
import { ExternalServiceError, HttpError } from "./errors";
import {
  createInstallationToken,
  getWorkflowRun,
  reviewDeployment,
} from "./github";
import { renderConfirmationPage, renderDecisionPage } from "./html";
import {
  htmlResponse,
  jsonResponse,
  parseJsonBytes,
  readBoundedBody,
  requireHeader,
  requireMediaType,
} from "./http";
import {
  validateStoredRequestAndRun,
  validateWebhook,
  validateWebhookAndRun,
} from "./policy";
import {
  decisionTokenPayloadSchema,
  deploymentProtectionWebhookSchema,
  parseRuntimeConfiguration,
  parseRuntimeSecrets,
  type DeploymentDecision,
  type StoredDeploymentRequest,
} from "./schemas";
import {
  getStoredRequest,
  listStoredRequests,
  storeDecision,
  storePendingRequest,
} from "./store";

const MAXIMUM_WEBHOOK_BYTES = 1024 * 1024;
const MAXIMUM_FORM_BYTES = 8 * 1024;
const DECISION_TOKEN_LIFETIME_SECONDS = 2 * 60;
const deliveryIdSchema = z.uuid();
const routeNumberSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(z.number().int().positive());
const authorizePathSchema = z.tuple([
  z.literal(""),
  z.literal("approval"),
  z.literal("authorize"),
  z.string(),
  z.string(),
]);
const decisionPathSchema = z.tuple([
  z.literal(""),
  z.literal("approval"),
  z.literal("decision"),
  z.string(),
  z.string(),
]);

interface RouteIdentifiers {
  attempt: number;
  runId: number;
}

function parseRouteIdentifiers(
  values: readonly [string, string],
): RouteIdentifiers {
  const runId = routeNumberSchema.safeParse(values[0]);
  const attempt = routeNumberSchema.safeParse(values[1]);
  if (!runId.success || !attempt.success) {
    throw new HttpError("URL の run ID または試行回数が不正です", 400, {
      cause: !runId.success ? runId.error : attempt.error,
    });
  }
  return { attempt: attempt.data, runId: runId.data };
}

function methodNotAllowed(allowedMethod: string): Response {
  return new Response("この HTTP メソッドは利用できません", {
    headers: {
      Allow: allowedMethod,
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
    status: 405,
  });
}

function handleHealth(env: Env): Response {
  parseRuntimeConfiguration(env);
  parseRuntimeSecrets(env);
  return jsonResponse({ status: "ok" }, 200);
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  requireMediaType(request, "application/json");
  const eventName = requireHeader(request, "X-GitHub-Event");
  if (eventName !== "deployment_protection_rule") {
    throw new HttpError("対象外の GitHub Webhook イベントです", 400, {});
  }

  const signature = requireHeader(request, "X-Hub-Signature-256");
  const deliveryIdValue = requireHeader(request, "X-GitHub-Delivery");
  const deliveryId = deliveryIdSchema.safeParse(deliveryIdValue);
  if (!deliveryId.success) {
    throw new HttpError("X-GitHub-Delivery が UUID ではありません", 400, {
      cause: deliveryId.error,
    });
  }

  const body = await readBoundedBody(request.body, MAXIMUM_WEBHOOK_BYTES);
  const secrets = parseRuntimeSecrets(env);
  const signatureIsValid = await verifyWebhookSignature(
    body,
    signature,
    secrets.GITHUB_WEBHOOK_SECRET,
  );
  if (!signatureIsValid) {
    throw new HttpError("GitHub Webhook の署名が一致しません", 401, {});
  }

  const parsedBody = deploymentProtectionWebhookSchema.safeParse(
    parseJsonBytes(body, "GitHub Webhook の JSON が不正です", 400),
  );
  if (!parsedBody.success) {
    throw new HttpError("GitHub Webhook の内容が不正です", 400, {
      cause: parsedBody.error,
    });
  }

  const configuration = parseRuntimeConfiguration(env);
  const runId = validateWebhook(parsedBody.data, configuration);
  const installationToken = await createInstallationToken(
    parsedBody.data.installation.id,
    configuration,
    secrets,
  );
  const run = await getWorkflowRun(runId, configuration, installationToken);
  const deploymentRequest = validateWebhookAndRun(
    parsedBody.data,
    run,
    deliveryId.data,
    new Date().toISOString(),
    configuration,
  );
  await storePendingRequest(env.DEPLOYMENT_REQUESTS, deploymentRequest);

  console.log(
    JSON.stringify({
      attempt: deploymentRequest.attempt,
      message: "承認要求を受理しました",
      runId: deploymentRequest.runId,
    }),
  );
  return jsonResponse(
    {
      attempt: deploymentRequest.attempt,
      runId: deploymentRequest.runId,
      status: "pending",
    },
    202,
  );
}

async function createToken(
  request: StoredDeploymentRequest,
  decision: DeploymentDecision,
  secret: string,
): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = decisionTokenPayloadSchema.parse({
    attempt: request.attempt,
    decision,
    deploymentId: request.deploymentId,
    exp: issuedAt + DECISION_TOKEN_LIFETIME_SECONDS,
    iat: issuedAt,
    installationId: request.installationId,
    repositoryId: request.repositoryId,
    runId: request.runId,
  });
  return await createDecisionToken(payload, secret);
}

async function handleAuthorization(
  request: Request,
  env: Env,
  identifiers: RouteIdentifiers,
): Promise<Response> {
  const configuration = parseRuntimeConfiguration(env);
  const secrets = parseRuntimeSecrets(env);
  await verifyAccessIdentity(request, configuration);

  const deploymentRequest = await getStoredRequest(
    env.DEPLOYMENT_REQUESTS,
    identifiers.runId,
    identifiers.attempt,
  );
  const installationToken = await createInstallationToken(
    deploymentRequest.installationId,
    configuration,
    secrets,
  );
  const run = await getWorkflowRun(
    deploymentRequest.runId,
    configuration,
    installationToken,
  );
  validateStoredRequestAndRun(deploymentRequest, run, configuration);

  const [approveToken, rejectToken] = await Promise.all([
    createToken(deploymentRequest, "approved", secrets.DECISION_TOKEN_SECRET),
    createToken(deploymentRequest, "rejected", secrets.DECISION_TOKEN_SECRET),
  ]);
  return htmlResponse(
    renderConfirmationPage(deploymentRequest, approveToken, rejectToken),
    200,
  );
}

async function readDecisionToken(request: Request): Promise<string> {
  requireMediaType(request, "application/x-www-form-urlencoded");

  const body = await readBoundedBody(request.body, MAXIMUM_FORM_BYTES);
  let parameters: URLSearchParams;
  try {
    parameters = new URLSearchParams(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    );
  } catch (error) {
    throw new HttpError("フォームを解析できません", 400, { cause: error });
  }
  const token = parameters.get("token");
  if (token == null || token === "") {
    throw new HttpError("決定トークンがありません", 400, {});
  }
  if (parameters.size !== 1) {
    throw new HttpError("フォームに未対応の項目があります", 400, {});
  }
  return token;
}

function validateTokenAgainstRequest(
  token: Awaited<ReturnType<typeof verifyDecisionToken>>,
  request: StoredDeploymentRequest,
  identifiers: RouteIdentifiers,
): void {
  const matches =
    token.runId === identifiers.runId &&
    token.attempt === identifiers.attempt &&
    token.runId === request.runId &&
    token.attempt === request.attempt &&
    token.deploymentId === request.deploymentId &&
    token.installationId === request.installationId &&
    token.repositoryId === request.repositoryId;
  if (!matches) {
    throw new HttpError("決定トークンが承認要求と一致しません", 403, {});
  }
}

async function handleDecision(
  request: Request,
  env: Env,
  identifiers: RouteIdentifiers,
): Promise<Response> {
  const configuration = parseRuntimeConfiguration(env);
  const secrets = parseRuntimeSecrets(env);
  const encodedToken = await readDecisionToken(request);
  const token = await verifyDecisionToken(
    encodedToken,
    secrets.DECISION_TOKEN_SECRET,
    Math.floor(Date.now() / 1000),
    DECISION_TOKEN_LIFETIME_SECONDS,
  );
  const deploymentRequest = await getStoredRequest(
    env.DEPLOYMENT_REQUESTS,
    identifiers.runId,
    identifiers.attempt,
  );
  validateTokenAgainstRequest(token, deploymentRequest, identifiers);

  const installationToken = await createInstallationToken(
    deploymentRequest.installationId,
    configuration,
    secrets,
  );
  const run = await getWorkflowRun(
    deploymentRequest.runId,
    configuration,
    installationToken,
  );
  validateStoredRequestAndRun(deploymentRequest, run, configuration);
  await reviewDeployment(
    deploymentRequest.callbackUrl,
    token.decision,
    configuration,
    installationToken,
  );

  try {
    await storeDecision(
      env.DEPLOYMENT_REQUESTS,
      deploymentRequest,
      token.decision,
      new Date().toISOString(),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        message: "GitHub の決定後に KV の状態を更新できませんでした",
        runId: deploymentRequest.runId,
      }),
    );
  }

  console.log(
    JSON.stringify({
      attempt: deploymentRequest.attempt,
      decision: token.decision,
      message: "GitHub が承認結果を受理しました",
      runId: deploymentRequest.runId,
    }),
  );
  return htmlResponse(
    renderDecisionPage(token.decision, deploymentRequest.runUrl),
    200,
  );
}

async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    return request.method === "GET"
      ? handleHealth(env)
      : methodNotAllowed("GET");
  }

  if (url.pathname === "/github/webhook") {
    return request.method === "POST"
      ? await handleWebhook(request, env)
      : methodNotAllowed("POST");
  }

  if (url.pathname === "/api/deployment-requests") {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }
    const requests = await listStoredRequests(env.DEPLOYMENT_REQUESTS);
    return jsonResponse({ requests }, 200);
  }

  const authorizePath = authorizePathSchema.safeParse(url.pathname.split("/"));
  if (authorizePath.success) {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }
    return await handleAuthorization(
      request,
      env,
      parseRouteIdentifiers([authorizePath.data[3], authorizePath.data[4]]),
    );
  }

  const decisionPath = decisionPathSchema.safeParse(url.pathname.split("/"));
  if (decisionPath.success) {
    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }
    return await handleDecision(
      request,
      env,
      parseRouteIdentifiers([decisionPath.data[3], decisionPath.data[4]]),
    );
  }

  return await env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await routeRequest(request, env);
    } catch (error) {
      const url = new URL(request.url);
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : "UnknownError",
          message: "リクエスト処理に失敗しました",
          method: request.method,
          path: url.pathname,
        }),
      );

      if (error instanceof HttpError) {
        return jsonResponse({ error: error.message }, error.status);
      }
      if (error instanceof ExternalServiceError) {
        return jsonResponse(
          { error: "外部サービスとの通信に失敗しました" },
          502,
        );
      }
      return jsonResponse(
        { error: "Worker 内部で予期しないエラーが発生しました" },
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;
