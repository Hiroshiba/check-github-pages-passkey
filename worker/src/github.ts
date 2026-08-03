import { importPKCS8, SignJWT } from "jose";
import { ExternalServiceError, UnreachableError } from "./errors";
import { parseJsonBytes, readBoundedBody } from "./http";
import {
  installationTokenResponseSchema,
  workflowRunSchema,
  type DeploymentDecision,
  type RuntimeConfiguration,
  type RuntimeSecrets,
  type WorkflowRun,
} from "./schemas";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAXIMUM_GITHUB_RESPONSE_BYTES = 1024 * 1024;

function githubHeaders(token: string): Headers {
  return new Headers({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  });
}

function isTransientStatus(status: number): boolean {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function fetchGetWithRetry(
  url: string,
  token: string,
  maximumAttempts: number,
): Promise<Response> {
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: githubHeaders(token) });
      if (!isTransientStatus(response.status) || attempt === maximumAttempts) {
        return response;
      }
      if (response.body != null) {
        await response.body.cancel();
      }
    } catch (error) {
      if (attempt === maximumAttempts) {
        throw new ExternalServiceError("GitHub API へ接続できませんでした", {
          cause: error,
        });
      }
    }
    await wait(attempt * 200);
  }

  throw new UnreachableError("GitHub API のリトライ処理が終了しませんでした");
}

async function readGitHubJson(response: Response): Promise<unknown> {
  let body: Uint8Array;
  try {
    body = await readBoundedBody(response.body, MAXIMUM_GITHUB_RESPONSE_BYTES);
  } catch (error) {
    throw new ExternalServiceError("GitHub API の応答を読み込めませんでした", {
      cause: error,
    });
  }
  return parseJsonBytes(body, "GitHub API の JSON が不正です", 502);
}

async function createAppJwt(
  configuration: RuntimeConfiguration,
  secrets: RuntimeSecrets,
): Promise<string> {
  const currentEpochSeconds = Math.floor(Date.now() / 1000);

  try {
    const privateKey = await importPKCS8(
      secrets.GITHUB_APP_PRIVATE_KEY,
      "RS256",
    );
    return await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt(currentEpochSeconds - 60)
      .setIssuer(configuration.GITHUB_APP_CLIENT_ID)
      .setExpirationTime(currentEpochSeconds + 8 * 60)
      .sign(privateKey);
  } catch (error) {
    throw new ExternalServiceError("GitHub App JWT を生成できませんでした", {
      cause: error,
    });
  }
}

/** 対象リポジトリだけに制限した GitHub App installation token を作る。 */
export async function createInstallationToken(
  installationId: number,
  configuration: RuntimeConfiguration,
  secrets: RuntimeSecrets,
): Promise<string> {
  const appJwt = await createAppJwt(configuration, secrets);
  let response: Response;

  try {
    response = await fetch(
      `${GITHUB_API_ORIGIN}/app/installations/${installationId.toString()}/access_tokens`,
      {
        body: JSON.stringify({
          permissions: { actions: "read", deployments: "write" },
          repository_ids: [configuration.ALLOWED_REPOSITORY_ID],
        }),
        headers: new Headers({
          ...Object.fromEntries(githubHeaders(appJwt)),
          "Content-Type": "application/json",
        }),
        method: "POST",
      },
    );
  } catch (error) {
    throw new ExternalServiceError(
      "GitHub App installation token を取得できませんでした",
      { cause: error },
    );
  }

  const body = await readGitHubJson(response);
  if (response.status !== 201) {
    throw new ExternalServiceError(
      `GitHub App installation token の取得に失敗しました。HTTP ${response.status.toString()}`,
      { cause: new Error(JSON.stringify(body)) },
    );
  }

  const parsed = installationTokenResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ExternalServiceError(
      "GitHub App installation token の応答が不正です",
      { cause: parsed.error },
    );
  }
  return parsed.data.token;
}

/** GitHub Actions の Workflow run を取得する。 */
export async function getWorkflowRun(
  runId: number,
  configuration: RuntimeConfiguration,
  installationToken: string,
): Promise<WorkflowRun> {
  const response = await fetchGetWithRetry(
    `${GITHUB_API_ORIGIN}/repos/${configuration.ALLOWED_REPOSITORY}/actions/runs/${runId.toString()}`,
    installationToken,
    3,
  );
  const body = await readGitHubJson(response);

  if (response.status !== 200) {
    throw new ExternalServiceError(
      `Workflow run を取得できませんでした。HTTP ${response.status.toString()}`,
      { cause: new Error(JSON.stringify(body)) },
    );
  }

  const parsed = workflowRunSchema.safeParse(body);
  if (!parsed.success) {
    throw new ExternalServiceError("Workflow run の応答が不正です", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** GitHub の custom deployment protection rule に決定を返す。 */
export async function reviewDeployment(
  callbackUrl: string,
  decision: DeploymentDecision,
  configuration: RuntimeConfiguration,
  installationToken: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(callbackUrl, {
      body: JSON.stringify({
        comment:
          decision === "approved"
            ? "Cloudflare Access の端末内蔵認証器による認証を通過しました"
            : "Cloudflare Access の端末内蔵認証器による認証後に却下されました",
        environment_name: configuration.ALLOWED_ENVIRONMENT,
        state: decision,
      }),
      headers: new Headers({
        ...Object.fromEntries(githubHeaders(installationToken)),
        "Content-Type": "application/json",
      }),
      method: "POST",
    });
  } catch (error) {
    throw new ExternalServiceError("GitHub へ承認結果を送信できませんでした", {
      cause: error,
    });
  }

  if (response.status !== 204) {
    const body = await readGitHubJson(response);
    throw new ExternalServiceError(
      `GitHub が承認結果を受理しませんでした。HTTP ${response.status.toString()}`,
      { cause: new Error(JSON.stringify(body)) },
    );
  }
}
