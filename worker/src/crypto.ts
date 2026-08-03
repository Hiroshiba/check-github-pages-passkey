import { z } from "zod";
import { HttpError } from "./errors";
import {
  decisionTokenPayloadSchema,
  type DecisionTokenPayload,
} from "./schemas";

const webhookSignatureSchema = z.string().regex(/^sha256=[0-9a-f]{64}$/);
const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const encodedTokenSchema = z.tuple([base64UrlSchema, base64UrlSchema]);

function encodeBase64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
    "",
  );
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const paddingLength = (4 - (normalized.length % 4)) % 4;

  try {
    const binary = atob(
      normalized.padEnd(normalized.length + paddingLength, "="),
    );
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch (error) {
    throw new HttpError("決定トークンの形式が不正です", 400, {
      cause: error,
    });
  }
}

function decodeHex(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    const byte = Number.parseInt(value.slice(index, index + 2), 16);
    if (Number.isNaN(byte)) {
      throw new HttpError("Webhook 署名の形式が不正です", 400, {});
    }
    bytes[index / 2] = byte;
  }
  return bytes;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );
}

/** GitHub Webhook の HMAC 署名を検証する。 */
export async function verifyWebhookSignature(
  body: Uint8Array,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  const parsed = webhookSignatureSchema.safeParse(signatureHeader);
  if (!parsed.success) {
    return false;
  }

  const signature = decodeHex(parsed.data.slice("sha256=".length));
  const key = await importHmacKey(secret);
  return await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new Uint8Array(body),
  );
}

/** 短時間だけ有効な署名済み決定トークンを生成する。 */
export async function createDecisionToken(
  payload: DecisionTokenPayload,
  secret: string,
): Promise<string> {
  const encodedPayload = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(encodedPayload),
  );
  return `${encodedPayload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** 署名済み決定トークンを検証する。 */
export async function verifyDecisionToken(
  token: string,
  secret: string,
  currentEpochSeconds: number,
  maximumLifetimeSeconds: number,
): Promise<DecisionTokenPayload> {
  const parts = encodedTokenSchema.safeParse(token.split("."));
  if (!parts.success) {
    throw new HttpError("決定トークンの形式が不正です", 400, {
      cause: parts.error,
    });
  }

  const [encodedPayload, encodedSignature] = parts.data;
  const key = await importHmacKey(secret);
  const signature = decodeBase64Url(encodedSignature);
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(encodedPayload),
  );
  if (!verified) {
    throw new HttpError("決定トークンの署名が一致しません", 403, {});
  }

  const payloadBytes = decodeBase64Url(encodedPayload);
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        payloadBytes,
      ),
    );
  } catch (error) {
    throw new HttpError("決定トークンを解析できません", 400, {
      cause: error,
    });
  }

  const parsed = decisionTokenPayloadSchema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError("決定トークンの内容が不正です", 400, {
      cause: parsed.error,
    });
  }
  if (parsed.data.iat > currentEpochSeconds) {
    throw new HttpError("決定トークンの発行時刻が未来です", 403, {});
  }
  if (
    parsed.data.exp <= parsed.data.iat ||
    parsed.data.exp - parsed.data.iat > maximumLifetimeSeconds
  ) {
    throw new HttpError("決定トークンの有効期間が不正です", 403, {});
  }
  if (parsed.data.exp <= currentEpochSeconds) {
    throw new HttpError("決定トークンの有効期限が切れています", 410, {});
  }
  return parsed.data;
}
