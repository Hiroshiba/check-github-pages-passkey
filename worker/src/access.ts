import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { ExternalServiceError, HttpError } from "./errors";
import {
  accessJwtClaimsSchema,
  type RuntimeConfiguration,
  type RuntimeSecrets,
} from "./schemas";

async function verifyJwt(
  token: string,
  configuration: RuntimeConfiguration,
): Promise<unknown> {
  const jwks = createRemoteJWKSet(
    new URL(`${configuration.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`),
  );
  const result = await jwtVerify(token, jwks, {
    audience: configuration.ACCESS_AUD,
    issuer: configuration.ACCESS_TEAM_DOMAIN,
  });
  return result.payload;
}

function isInvalidJwtError(error: unknown): boolean {
  return (
    error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout)
  );
}

/** Cloudflare Access の JWT と承認者を検証する。 */
export async function verifyAccessIdentity(
  request: Request,
  configuration: RuntimeConfiguration,
  secrets: RuntimeSecrets,
): Promise<void> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (token == null || token === "") {
    throw new HttpError("Cloudflare Access の JWT がありません", 403, {});
  }

  let payload: unknown;
  try {
    payload = await verifyJwt(token, configuration);
  } catch (error) {
    if (isInvalidJwtError(error)) {
      throw new HttpError("Cloudflare Access の JWT が不正です", 403, {
        cause: error,
      });
    }

    try {
      payload = await verifyJwt(token, configuration);
    } catch (retryError) {
      if (isInvalidJwtError(retryError)) {
        throw new HttpError("Cloudflare Access の JWT が不正です", 403, {
          cause: retryError,
        });
      }
      throw new ExternalServiceError(
        "Cloudflare Access の公開鍵を取得できませんでした",
        { cause: retryError },
      );
    }
  }

  const claims = accessJwtClaimsSchema.safeParse(payload);
  if (!claims.success) {
    throw new HttpError(
      "Cloudflare Access の JWT に必要な情報がありません",
      403,
      {
        cause: claims.error,
      },
    );
  }
  if (claims.data.email !== secrets.APPROVER_EMAIL) {
    throw new HttpError("このアカウントには承認権限がありません", 403, {});
  }
}
