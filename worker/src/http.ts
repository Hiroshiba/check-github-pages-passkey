import { assertNonNullable } from "../../shared/assert-non-nullable";
import { HttpError } from "./errors";

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} satisfies HeadersInit;

const HTML_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self'; style-src 'self'",
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} satisfies HeadersInit;

/** JSON の HTTP 応答を生成する。 */
export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    headers: JSON_HEADERS,
    status,
  });
}

/** HTML の HTTP 応答を生成する。 */
export function htmlResponse(body: string, status: number): Response {
  return new Response(body, {
    headers: HTML_HEADERS,
    status,
  });
}

/** 本文を上限付きで読み込む。 */
export async function readBoundedBody(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (stream == null) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let totalBytes = 0;

  try {
    let result = await reader.read();
    while (!result.done) {
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        throw new HttpError("リクエスト本文が大きすぎます", 413, {});
      }
      chunks.push(result.value);
      result = await reader.read();
    }
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError("リクエスト本文を読み込めませんでした", 400, {
      cause: error,
    });
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** UTF-8 の JSON 本文を解析する。 */
export function parseJsonBytes(
  body: Uint8Array,
  message: string,
  status: number,
): unknown {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(body);
    const value: unknown = JSON.parse(text);
    return value;
  } catch (error) {
    throw new HttpError(message, status, { cause: error });
  }
}

/** 必須 HTTP ヘッダーを取得する。 */
export function requireHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (value == null || value === "") {
    throw new HttpError(`${name} ヘッダーがありません`, 400, {});
  }
  return value;
}

/** 必須 Content-Type を検証する。 */
export function requireMediaType(request: Request, expected: string): void {
  const contentType = requireHeader(request, "Content-Type");
  const mediaType = contentType.split(";").at(0);
  assertNonNullable(mediaType, "Content-Type の解析結果がありません");
  if (mediaType.trim().toLowerCase() !== expected) {
    throw new HttpError(`Content-Type は ${expected} が必要です`, 415, {});
  }
}
