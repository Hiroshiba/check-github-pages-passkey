# Cloudflare Terraform 運用

`terraform/cloudflare` は承認機構が使う次の Cloudflare リソースを管理します。

- Zero Trust organization の independent MFA 利用条件
- One-time PIN identity provider
- App Launcher と承認者登録用 policy
- 承認 URL だけを保護する Access application と policy
- 承認要求を保存する Workers KV namespace

Worker のコード、静的 assets、binding、非機密変数、Secret は Wrangler が管理します。同じリソースを Terraform と Wrangler の両方から管理しません。Terraform は `wrangler.jsonc` を読み、承認者一覧、現在の Access AUD、KV namespace ID を参照します。

Cloudflare の仕様上、independent MFA の利用許可は organization 設定が必須です。Terraform は organization 全体への MFA 適用を無効にし、organization の通常のセッションと MFA の既定値を24時間にします。承認 application のセッションと biometrics MFA の再認証間隔は15分です。MFA 以外の organization 設定は現在値を読み取り、そのまま更新要求へ含めます。

この構成では、One-time PIN の再入力が15分ごとに発生するとは限りません。organization の SSO セッションが有効でも、承認 URL では15分を過ぎると Windows Hello または Touch ID を再要求します。

## 初回移行

Terraform 1.14 を用意します。Cloudflare API token は対象 account のみに限定し、次の read と write 権限を付けます。

- Access: Apps and Policies
- Access: Organizations, Identity Providers, and Groups
- Workers KV Storage

Cloudflare 管理者は Dashboard の My Profile、API Tokens から Create Token を選び、Custom token を作ります。3個の Account permission は Edit にし、Account Resources は対象 account だけを Include します。作業時間に合わせた TTL も設定します。token は一度しか表示されないため、パスワードマネージャーへ保存します。

account ID は Dashboard の account Overview または `pnpm wrangler whoami` で確認します。token はファイルやシェル履歴へ保存せず、環境変数で Terraform に渡します。

```shell
read -rsp "Cloudflare API token: " CLOUDFLARE_API_TOKEN
export CLOUDFLARE_API_TOKEN
printf '\n'
export TF_VAR_cloudflare_account_id="32文字のCloudflare account ID"
terraform -chdir=terraform/cloudflare init
terraform -chdir=terraform/cloudflare plan -out=cloudflare.tfplan
terraform -chdir=terraform/cloudflare show cloudflare.tfplan
terraform -chdir=terraform/cloudflare apply cloudflare.tfplan
```

既存の Access application、App Launcher、One-time PIN、reusable policy、KV namespace は Cloudflare API から検出し、import block が state へ取り込みます。承認 application は AUD と保護対象 URL で特定します。該当リソースがなければ新規作成します。候補が複数ある場合は処理を中断します。

Zero Trust organization は Provider が import に対応していません。このリソースは現在の organization をデータソースで取得し、MFA とセッション以外を保持したまま API endpoint を更新して state に記録します。Zero Trust team domain が `wrangler.jsonc` と異なる account では処理を中断します。

plan では次を確認します。

- destroy と置換がない
- Zero Trust organization と2個の reusable policy だけが create と表示される
- 承認 application の保護対象が `/approval/authorize/*` だけ
- organization 全体への MFA 適用が無効
- 承認 application のセッションと MFA が15分
- MFA method が承認 policy では Biometrics だけ
- App Launcher と承認 policy のメールアドレスが `wrangler.jsonc` と一致

Zero Trust organization は import 非対応のため、既存でも create と表示されます。これと2個の reusable policy 以外の既存リソースが create と表示された場合は apply しません。Cloudflare account ID、API token の対象 account、`wrangler.jsonc` の AUD と KV ID を確認します。

適用後に Worker 設定との一致を確認します。

```shell
terraform -chdir=terraform/cloudflare output
pnpm run worker:types
pnpm run check
```

`access_aud` または `deployment_requests_kv_namespace_id` の不一致が報告された場合は、出力値を `wrangler.jsonc` へ反映して Worker を再デプロイします。既存環境を正しく import した場合は変更不要です。

作業後は token を環境から削除します。

```shell
unset CLOUDFLARE_API_TOKEN
unset TF_VAR_cloudflare_account_id
```

## 通常運用

承認者の追加では `wrangler.jsonc` の `ALLOWED_APPROVER_EMAILS` だけを編集します。Terraform が同じ一覧を2個の Access policy に反映します。

追加時は Terraform を先に適用し、その後 Worker をデプロイします。途中では Access が通っても Worker の許可一覧が拒否するため、権限が早く有効になることはありません。

```shell
terraform -chdir=terraform/cloudflare plan -out=cloudflare.tfplan
terraform -chdir=terraform/cloudflare apply cloudflare.tfplan
pnpm run worker:types
pnpm run check
pnpm wrangler deploy
```

承認者の削除では Worker を先にデプロイし、その後 Terraform を適用します。これにより削除対象者を Worker が先に拒否します。

Terraform のローカル state と plan は Git の管理外です。state には Cloudflare から取得した構成が入るため、機密情報と同様に扱います。state を失うと意図した差分を確認できなくなるため、安全な場所へバックアップします。複数人で運用する前に、locking を利用できる remote backend へ移行します。

すべての管理対象リソースには `prevent_destroy` があります。`terraform destroy` は運用手順として使用しません。

ユーザーによる MFA device の登録、Cloudflare API token の作成、plan の確認、Worker Secret の登録、実ブラウザでの認証確認は Terraform では代行できません。
