# Cloudflare デプロイ

`terraform/cloudflare` は承認機構が使う次の Cloudflare リソースを管理します。

- Zero Trust organization の independent MFA 利用条件
- One-time PIN identity provider
- App Launcher と承認者登録用 policy
- 承認 URL だけを保護する Access application と policy
- 承認要求を保存する Workers KV namespace

Worker のコード、静的 assets、binding、非機密変数は Wrangler が管理します。Worker Secret は Cloudflare に一度登録し、以降のデプロイでも保持します。同じリソースを Terraform と Wrangler の両方から管理しません。

Terraform は `wrangler.jsonc` から承認者一覧、Access AUD、KV namespace ID を読みます。organization 全体への MFA 適用は無効にし、通常の SSO セッションと MFA の既定値を24時間にします。承認 application のセッションと Biometrics MFA の再認証間隔だけを15分にします。

One-time PIN の再入力は15分ごとに発生するとは限りません。organization の SSO セッションが有効でも、承認 URL では15分を過ぎると Windows Hello または Touch ID を再要求します。

## GitHub Workflow

`.github/workflows/deploy-cloudflare.yml` は production ref 上の固定定義からだけ実行します。デプロイ対象には main から到達できる40文字のコミット SHA を指定します。

Workflow は次の順で処理します。

1. production ref、main からの到達性、`EXPECTED_WORKFLOW_SHA` を権限なしで検証する。
2. `cloudflare-plan` Environment の承認後に R2 の remote state をロックして plan を作る。
3. plan を1日だけ artifact に保存し、SHA-256 を記録する。
4. `cloudflare-production` Environment の承認後に同じ plan のハッシュを検証して適用する。
5. Terraform の出力と `wrangler.jsonc` の AUD と KV namespace ID が一致することを検証する。
6. 静的検証を通過した承認用 Worker を Wrangler でデプロイする。

最初の承認では、指定されたソース SHA の変更内容を確認します。Terraform は plan 中にもデータソースや Provider のコードを実行するため、未確認のソースへ plan 用資格情報を渡しません。

2回目の承認では、plan job のログに表示された差分を確認します。destroy、意図しない置換、対象外リソースの変更があれば拒否します。

plan artifact は1日で失効します。期限内に2回目の承認を完了できなかった場合は、同じソース SHA から新しい plan を作ります。

Cloudflare 設定をデプロイするには、GitHub Actions で `固定 Cloudflare デプロイ` を選び、実行 branch に production、入力にソース SHA を指定します。

```shell
gh workflow run .github/workflows/deploy-cloudflare.yml \
  --ref production \
  --field source_sha=デプロイする40文字のコミットSHA
```

Terraform は常に Worker より先に適用します。承認者を追加する途中では Worker の古い許可一覧が拒否し、削除する途中では Access の新しい policy が拒否します。どちらも Worker のデプロイが失敗した時点で権限が広がりません。

GitHub Environment、Cloudflare API token、R2 資格情報の作成手順は [必須セットアップ](required-setup.md#cloudflare-デプロイを準備する)だけに記載します。

## 初回 plan

既存の Access application、App Launcher、One-time PIN、reusable policy、KV namespace は Cloudflare API から検出し、import block が state へ取り込みます。承認 application は AUD と保護対象 URL で特定します。候補が複数ある場合は plan を失敗させます。

Zero Trust organization は Provider が import に対応していません。現在値をデータソースで取得し、MFA とセッション以外を保持したまま API endpoint を更新して state に記録します。Zero Trust team domain が `wrangler.jsonc` と異なる account では plan を失敗させます。

初回 plan では次を確認します。

- destroy と置換がない
- Zero Trust organization と2個の reusable policy だけが create と表示される
- 承認 application の保護対象が `/approval/authorize/*` だけ
- organization 全体への MFA 適用が無効
- 承認 application のセッションと MFA が15分
- 承認 policy の MFA method が Biometrics だけ
- App Launcher と承認 policy のメールアドレスが `wrangler.jsonc` と一致

Zero Trust organization と2個の reusable policy 以外の既存リソースが create と表示された場合は apply を承認しません。Cloudflare account ID、API token の対象 account、`wrangler.jsonc` の AUD と KV ID を確認します。

新しい Cloudflare account では、最初の apply 後に AUD または KV namespace ID の不一致で Worker デプロイ前に停止することがあります。Terraform の出力値を `wrangler.jsonc` へ反映し、Worker Secret を初回登録してから新しいソース SHA で再実行します。

## State と復旧

backend は `check-github-pages-passkey-terraform-state` R2 bucket の `cloudflare/terraform.tfstate` を使います。Terraform の S3 lockfile を有効にし、同時更新を拒否します。bucket と R2 S3 API token は backend より先に必要なため、初回だけ手動で作成します。

既存の local state がある場合は、GitHub Workflow を初めて実行する前に R2 資格情報を環境変数へ設定し、state を移行します。

```shell
read -rp "R2 Access Key ID: " AWS_ACCESS_KEY_ID
read -rsp "R2 Secret Access Key: " AWS_SECRET_ACCESS_KEY
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
printf '\n'
export AWS_ENDPOINT_URL="https://Cloudflareのaccount ID.r2.cloudflarestorage.com"
terraform -chdir=terraform/cloudflare init -migrate-state
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_ENDPOINT_URL
```

state と saved plan には Cloudflare から取得した構成が入ります。機密情報と同様に扱い、Git へ追加しません。plan artifact は GitHub Actions 内で1日後に削除されます。

すべての管理対象リソースには `prevent_destroy` があります。`terraform destroy` は使いません。意図しない変更を適用した場合は、正しい構成を main へ反映し、新しい plan を確認して再適用します。

認証器の登録、API token の作成、plan の確認、Worker Secret の初回登録、実ブラウザでの認証確認は自動化しません。
