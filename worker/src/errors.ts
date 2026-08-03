/** HTTP 応答へ変換できる処理済みエラーを表す。 */
export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number, options: ErrorOptions) {
    super(message, options);
    this.name = "HttpError";
    this.status = status;
  }
}

/** 外部サービスとの通信失敗を表す。 */
export class ExternalServiceError extends Error {
  constructor(message: string, options: ErrorOptions) {
    super(message, options);
    this.name = "ExternalServiceError";
  }
}

/** 到達不能な分岐へ到達したことを表す。 */
export class UnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreachableError";
  }
}
