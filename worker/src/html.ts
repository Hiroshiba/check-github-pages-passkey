import type { StoredDeploymentRequest } from "./schemas";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function detail(term: string, value: string): string {
  return `<div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

/** 承認または却下を確認する HTML を生成する。 */
export function renderConfirmationPage(
  request: StoredDeploymentRequest,
  approveToken: string,
  rejectToken: string,
): string {
  const action = `/approval/decision/${request.runId.toString()}/${request.attempt.toString()}`;
  const commitUrl = `https://github.com/${request.repository}/commit/${request.sourceSha}`;

  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light dark">
    <title>デプロイ内容の最終確認</title>
    <link rel="stylesheet" href="/confirmation.css">
  </head>
  <body>
    <main>
      <h1>デプロイ内容の最終確認</h1>
      <p>物理セキュリティキーの認証に成功しました。内容を確認して2分以内に決定してください。</p>
      <dl>
        ${detail("リポジトリ", request.repository)}
        ${detail("Workflow", request.workflowPath)}
        ${detail("ref", request.workflowRef)}
        ${detail("Workflow SHA", request.workflowSha)}
        ${detail("Environment", request.environment)}
        ${detail("デプロイ元 SHA", request.sourceSha)}
        ${detail("run ID", request.runId.toString())}
        ${detail("試行回数", request.attempt.toString())}
      </dl>
      <p><a href="${escapeHtml(commitUrl)}" rel="noreferrer">デプロイ元コミットを確認</a></p>
      <p><a href="${escapeHtml(request.runUrl)}" rel="noreferrer">GitHub Actions の実行を確認</a></p>
      <div class="actions">
        <form action="${escapeHtml(action)}" method="post">
          <input type="hidden" name="token" value="${escapeHtml(approveToken)}">
          <button type="submit">承認する</button>
        </form>
        <form action="${escapeHtml(action)}" method="post">
          <input type="hidden" name="token" value="${escapeHtml(rejectToken)}">
          <button class="reject" type="submit">却下する</button>
        </form>
      </div>
    </main>
  </body>
</html>`;
}

/** GitHub へ送信した決定を表示する HTML を生成する。 */
export function renderDecisionPage(
  decision: "approved" | "rejected",
  runUrl: string,
): string {
  const result = decision === "approved" ? "承認しました" : "却下しました";
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light dark">
    <title>${result}</title>
    <link rel="stylesheet" href="/confirmation.css">
  </head>
  <body>
    <main>
      <h1>${result}</h1>
      <p>GitHub が決定を受理しました。</p>
      <p><a href="${escapeHtml(runUrl)}" rel="noreferrer">GitHub Actions の実行を確認</a></p>
      <p><a href="/">承認要求の一覧へ戻る</a></p>
    </main>
  </body>
</html>`;
}
