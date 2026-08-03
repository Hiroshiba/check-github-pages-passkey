import { commitShaSchema } from "../../shared/deployment";
import { assertNonNullable } from "../../shared/assert-non-nullable";
import "./style.css";

const sourceShaElement = document.querySelector("#source-sha");
assertNonNullable(sourceShaElement, "デプロイ元 SHA の表示要素がありません");

if (import.meta.env.DEV) {
  sourceShaElement.textContent = "ローカル開発";
} else {
  sourceShaElement.textContent = commitShaSchema.parse(
    import.meta.env.VITE_SOURCE_SHA,
  );
}
