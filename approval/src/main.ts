import {
  deploymentRequestListSchema,
  type DeploymentRequestView,
} from "../../shared/deployment";
import { assertNonNullable } from "../../shared/assert-non-nullable";
import "./style.css";

const nullableListElement =
  document.querySelector<HTMLOListElement>("#requests");
const nullableReloadButton =
  document.querySelector<HTMLButtonElement>("#reload");
const nullableStatusElement = document.querySelector<HTMLElement>("#status");

assertNonNullable(nullableListElement, "承認要求の一覧要素がありません");
assertNonNullable(nullableReloadButton, "更新ボタンがありません");
assertNonNullable(nullableStatusElement, "状態の表示要素がありません");

const listElement = nullableListElement;
const reloadButton = nullableReloadButton;
const statusElement = nullableStatusElement;
const statusLabels = {
  approved: "承認済み",
  pending: "承認待ち",
  rejected: "却下済み",
} satisfies Record<DeploymentRequestView["status"], string>;

function createDetail(term: string, value: string): HTMLDivElement {
  const container = document.createElement("div");
  const description = document.createElement("dd");
  const title = document.createElement("dt");

  title.textContent = term;
  description.textContent = value;
  container.append(title, description);
  return container;
}

function createRequestElement(request: DeploymentRequestView): HTMLLIElement {
  const item = document.createElement("li");
  const title = document.createElement("h3");
  const details = document.createElement("dl");
  const runLink = document.createElement("a");

  item.className = `request request--${request.status}`;
  title.textContent = `${request.repository} の実行 ${request.runId.toString()}`;
  details.append(
    createDetail("状態", statusLabels[request.status]),
    createDetail("ソース SHA", request.sourceSha),
    createDetail("Workflow SHA", request.workflowSha),
    createDetail("ref", request.workflowRef),
    createDetail("Environment", request.environment),
    createDetail(
      "要求日時",
      new Date(request.requestedAt).toLocaleString("ja-JP"),
    ),
  );
  runLink.href = request.runUrl;
  runLink.textContent = "GitHub Actions の実行を確認";
  runLink.rel = "noreferrer";

  item.append(title, details, runLink);

  if (request.status === "pending") {
    const approvalLink = document.createElement("a");
    approvalLink.className = "approval-link";
    approvalLink.href = `/approval/authorize/${request.runId.toString()}/${request.attempt.toString()}`;
    approvalLink.textContent = "端末内蔵認証器で確認へ進む";
    item.append(approvalLink);
  }

  return item;
}

async function loadRequests(): Promise<void> {
  statusElement.textContent = "読み込み中です";
  reloadButton.setAttribute("disabled", "");

  try {
    const response = await fetch("/api/deployment-requests", {
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    if (!response.ok) {
      throw new Error(
        `承認要求を取得できませんでした。HTTP ${response.status.toString()}`,
      );
    }

    const body: unknown = await response.json();
    const parsed = deploymentRequestListSchema.parse(body);
    const items = parsed.requests.map(createRequestElement);

    listElement.replaceChildren(...items);
    statusElement.textContent =
      items.length === 0 ? "承認要求はありません" : "";
  } finally {
    reloadButton.removeAttribute("disabled");
  }
}

function handleFatalError(error: unknown): void {
  console.error(error);
  statusElement.textContent =
    error instanceof Error ? error.message : "承認要求の読み込みに失敗しました";
}

reloadButton.addEventListener("click", () => {
  void loadRequests().catch(handleFatalError);
});

void loadRequests().catch(handleFatalError);
