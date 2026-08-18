# 必須セットアップ

この文書は、初回導入と導入結果の確認だけを扱います。上から順に実行してください。

## 前提を確認する

- リポジトリを Public にする
- 通常利用者の権限を Write 以下にする
- break-glass 用管理者と Cloudflare 管理者の認証を承認専用認証と分離する
- Node.js 24、pnpm 10、Terraform 1.14、OpenSSL、GitHub CLI を用意する
- Cloudflare Zero Trust を開始し、team domain を作成する
- 承認者が One-time PIN を受信できるメールアドレスを用意する

個人リポジトリの所有者は Admin から下げられません。個人アカウントでは仕組みの動作確認に限定します。本番では Organization へ移し、通常利用アカウントを Write 以下にして、別の break-glass 用アカウントだけを Owner にします。

`terraform/settings.json` の次の値を導入先に合わせます。

- `cloudflare_account_id` は Cloudflare account ID
- `github_environment_reviewer_logins` はインフラ変更を承認する GitHub login の一覧

reviewer にはリポジトリへの Read 権限が必要です。Workflow の実行者と別の reviewer が承認できるようにします。

`wrangler.jsonc` の次の値も導入先に合わせます。

- `ACCESS_TEAM_DOMAIN`
- `ALLOWED_APPROVER_EMAILS`
- `ALLOWED_REPOSITORY`
- `ALLOWED_REPOSITORY_ID`
- `GITHUB_APP_CLIENT_ID`

`ACCESS_AUD` と `DEPLOYMENT_REQUESTS` の KV namespace ID は最初の Cloudflare Terraform 適用で決まるため、適用後に設定します。

GitHub の custom deployment protection rule は Public Preview です。導入時に最新の仕様を確認してください。

## Approval GitHub App を作る

GitHub App を 1 個作り、次だけを設定します。

- Homepage URL は `https://github.com/Hiroshiba/check-github-pages-passkey`
- Actions repository permission は Read-only
- Deployments repository permission は Read and write
- User authorization は使わない
- Deployment protection rule event を購読
- Webhook URL は `https://github-pages-deployment-approval.voicevox-oss.workers.dev/github/webhook`
- Webhook secret はパスワードマネージャーで生成した 32 文字以上の値
- SSL verification は有効
- Webhook は Active
- Where can this GitHub App be installed は Only on this account
- インストール先は `Hiroshiba/check-github-pages-passkey` だけ

Contents、Actions write、Pages、Administration の権限は付けません。App の Client ID、private key、Webhook secret を安全な場所に保管します。private key はリポジトリの外へ置きます。

App を対象リポジトリへインストールします。github-pages Environment での有効化は Worker の準備後に行います。

## Terraform の資格情報を作る

Cloudflare Dashboard で対象 account の R2 object storage を開き、次の手順で Terraform state 用の bucket と資格情報を作ります。

1. Overview で Create bucket を選ぶ。
2. Bucket name に `check-github-pages-passkey-terraform-state` を指定する。
3. Location は None のままにして Automatic 配置を使う。Specify jurisdiction は選ばない。
4. Create bucket を選び、bucket 一覧に表示されることを確認する。
5. Overview の Account Details で API Tokens の Manage を選ぶ。
6. Create Account API token を選ぶ。
7. Token name に `check-github-pages-passkey-terraform-state` を指定する。
8. Permissions は Object Read and Write を選ぶ。
9. Apply to specific buckets only を選び、作成した bucket だけを指定する。
10. token を作り、一度だけ表示される Access Key ID と Secret Access Key をパスワードマネージャーへ保存する。

対象 account だけを Include した Cloudflare API token を 2 個作ります。plan 用 token には次の Read 権限を設定します。

- Access: Apps Read
- Access: Policies Read
- Access: Organizations Read
- Access: Identity Providers Read
- Workers KV Storage Read

production 用 token には次の権限を設定します。

- Access: Apps Edit
- Access: Policies Edit
- Access: Organizations Edit
- Access: Identity Providers Edit
- Workers KV Storage Edit
- Workers Scripts Edit

GitHub の Fine-grained personal access token を plan 用と production 用に 1 個ずつ作ります。Resource owner と Repository access は対象リポジトリだけに限定します。

| Repository permission | plan      | production     |
| --------------------- | --------- | -------------- |
| Administration        | Read-only | Read and write |
| Contents              | Read-only | Read and write |
| Environments          | Read-only | Read and write |
| Pages                 | Read-only | Read and write |
| Variables             | Read-only | Read and write |

Token 名は GitHub の文字数制限に収まる短い名前にします。plan 用は `check-github-pages-passkeyのplan用`、production 用は `check-github-pages-passkeyのapply用` など、一覧で用途を識別できる名前にします。有効期限を設定します。No expiration を使う場合は手動ローテーション日を記録します。Token の値はパスワードマネージャー以外へ保存しません。

## GitHub Terraform を初回適用する

`terraform/settings.json` と `wrangler.jsonc` の導入先固有値を main に反映します。最初の 1 回は GitHub 設定用 Environment がまだないため、break-glass 管理者がローカルから適用します。

```shell
read -rsp "GitHub production token: " GITHUB_TOKEN
read -rp "R2 Access Key ID: " AWS_ACCESS_KEY_ID
read -rsp "R2 Secret Access Key: " AWS_SECRET_ACCESS_KEY
export GITHUB_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
printf '\n'
export AWS_ENDPOINT_URL="https://Cloudflareのaccount ID.r2.cloudflarestorage.com"
terraform -chdir=terraform/github init
terraform -chdir=terraform/github fmt -check -recursive
terraform -chdir=terraform/github validate
terraform -chdir=terraform/github plan -out=github.tfplan
```

plan に想定外の変更、削除、置換がないことを確認してから適用します。

```shell
terraform -chdir=terraform/github apply github.tfplan
unset GITHUB_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_ENDPOINT_URL
```

production の先頭コミット SHA を取得します。

```shell
gh api "repos/$(jq -r '.vars.ALLOWED_REPOSITORY' wrangler.jsonc)/commits/production" --jq .sha
```

出力値を `wrangler.jsonc` の `EXPECTED_WORKFLOW_SHA` に設定し、main に反映します。

## Environment Secret を登録する

GitHub Terraform の適用後、次の Environment Secret を登録します。

| Environment             | Secret                   | 値                             |
| ----------------------- | ------------------------ | ------------------------------ |
| `github-plan`           | `GITHUB_TERRAFORM_TOKEN` | GitHub plan 用 token           |
| `github-plan`           | `R2_ACCESS_KEY_ID`       | R2 Access Key ID               |
| `github-plan`           | `R2_SECRET_ACCESS_KEY`   | R2 Secret Access Key           |
| `github-production`     | `GITHUB_TERRAFORM_TOKEN` | GitHub production 用 token     |
| `github-production`     | `R2_ACCESS_KEY_ID`       | R2 Access Key ID               |
| `github-production`     | `R2_SECRET_ACCESS_KEY`   | R2 Secret Access Key           |
| `cloudflare-plan`       | `CLOUDFLARE_API_TOKEN`   | Cloudflare plan 用 token       |
| `cloudflare-plan`       | `R2_ACCESS_KEY_ID`       | R2 Access Key ID               |
| `cloudflare-plan`       | `R2_SECRET_ACCESS_KEY`   | R2 Secret Access Key           |
| `cloudflare-production` | `CLOUDFLARE_API_TOKEN`   | Cloudflare production 用 token |
| `cloudflare-production` | `R2_ACCESS_KEY_ID`       | R2 Access Key ID               |
| `cloudflare-production` | `R2_SECRET_ACCESS_KEY`   | R2 Secret Access Key           |

GitHub CLI から対話入力する場合は、次の形式で 1 個ずつ登録します。

```shell
gh secret set Secret名 --env Environment名
```

Approval GitHub App は自分自身と GitHub の保護設定を更新する Workflow を承認させないため、この 4 個の Environment では使いません。

GitHub 設定の固定 Workflow を production ref から実行します。

```shell
gh workflow run .github/workflows/deploy-github.yml \
  --ref production \
  --field source_sha=デプロイする40文字のコミットSHA
```

github-plan の承認前に指定ソースの差分を確認します。github-production の承認前に plan job のログを確認し、同じ plan が適用されることを確認します。

## Cloudflare Terraform を初回適用する

main からデプロイする 40 文字のコミット SHA を選び、production ref から固定 Workflow を実行します。

```shell
gh workflow run .github/workflows/deploy-cloudflare.yml \
  --ref production \
  --field source_sha=デプロイする40文字のコミットSHA
```

cloudflare-plan の承認前に指定ソースの差分と plan を確認します。想定外の変更、削除、置換がないことを確認します。cloudflare-production の承認前に plan job のログを確認します。承認すると同じ plan を適用します。

## Worker の Secret を登録する

Worker に次の Secret を登録します。

- `DECISION_TOKEN_SECRET`
- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_APP_PRIVATE_KEY`

最初の Cloudflare Terraform 適用後は Access AUD または KV namespace ID の不一致で Worker デプロイ前に停止します。R2 資格情報を設定して Terraform の出力を取得します。

```shell
read -rp "R2 Access Key ID: " AWS_ACCESS_KEY_ID
read -rsp "R2 Secret Access Key: " AWS_SECRET_ACCESS_KEY
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
printf '\n'
export AWS_ENDPOINT_URL="https://Cloudflareのaccount ID.r2.cloudflarestorage.com"
terraform -chdir=terraform/cloudflare init -reconfigure
terraform -chdir=terraform/cloudflare output -raw access_aud
terraform -chdir=terraform/cloudflare output -raw deployment_requests_kv_namespace_id
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_ENDPOINT_URL
```

出力値を `wrangler.jsonc` の `ACCESS_AUD` と `DEPLOYMENT_REQUESTS` の KV namespace ID に反映し、main に反映します。

GitHub App の private key を PKCS#8 に変換します。入力元と出力先はリポジトリの外に置きます。

```shell
openssl pkcs8 -topk8 -nocrypt \
  -in /安全な場所/github-app-private-key.pem \
  -out /安全な場所/github-app-private-key.pkcs8.pem
```

リポジトリ直下に一時ファイル `.env.initial-deploy` を作り、3 個の Secret を入力します。このファイルは `.gitignore` の対象ですが、Git の状態も必ず確認します。

```dotenv
DECISION_TOKEN_SECRET="パスワードマネージャーで生成した32文字以上の値"
GITHUB_WEBHOOK_SECRET="GitHub Appに設定したWebhook secret"
GITHUB_APP_PRIVATE_KEY="""
-----BEGIN PRIVATE KEY-----
PKCS#8へ変換したprivate key
-----END PRIVATE KEY-----
"""
```

production 用 Cloudflare API token と account ID を環境変数へ設定し、初回だけローカルから Worker をデプロイします。

```shell
read -rp "Cloudflare account ID: " CLOUDFLARE_ACCOUNT_ID
read -rsp "Cloudflare production API token: " CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN
printf '\n'
pnpm install --frozen-lockfile
pnpm wrangler deploy --secrets-file .env.initial-deploy
unset CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN
```

成功後すぐに `.env.initial-deploy` を削除します。Secret と private key をリポジトリ、Terraform state、`wrangler.jsonc`、GitHub Actions に保存しません。

新しい main のソース SHA で固定 Cloudflare デプロイをもう一度実行し、Worker まで成功することを確認します。

## MFA と承認ルールを有効にする

Terraform の適用後、承認者本人が各端末で次を実行します。この登録は自動化できません。

1. `https://voicevox-oss-01.cloudflareaccess.com/AddMfaDevice` を開く。
2. 自分のメールアドレスと One-time PIN でログインする。
3. Account の MFA devices から Add device を選ぶ。
4. Biometrics を選び、Windows Hello または Touch ID を登録する。
5. 端末を識別できる名前を付ける。
6. Cloudflare Dashboard の Users で登録内容を確認する。

最初の MFA device の登録では別の device による確認がありません。承認者を Access policy へ追加してから本人が登録するまでの時間を短くします。2 個目以降の登録には最初に登録した MFA device が必要です。

Worker のトップページと `/health` を開きます。`/health` が `200` と `{"status":"ok"}` を返した後、github-pages Environment の Deployment protection rules で Approval GitHub App を有効化します。この設定は Terraform GitHub Provider が対応していないため、手動で行います。

## 最初の GitHub Pages デプロイを確認する

main から公開したい 40 文字のコミット SHA を選び、production ref から固定 Workflow を実行します。

```shell
gh workflow run .github/workflows/deploy-pages.yml \
  --ref production \
  --field source_sha=公開する40文字のコミットSHA
```

ビルド後に deploy job が github-pages Environment で待機します。承認用 Worker のトップページを開き、対象 run を選びます。リポジトリ、Workflow、ref、Workflow SHA、Environment、ソース SHA を確認し、Windows Hello または Touch ID で承認します。

導入完了前に次を確認します。

- main ref から各固定 Workflow を実行すると拒否される
- GitHub と Cloudflare の plan と apply がそれぞれ別の承認を要求する
- `EXPECTED_WORKFLOW_SHA` と異なる run を Worker が拒否する
- Windows と macOS から承認すると、それぞれ Windows Hello と Touch ID を要求される
- 認証から 15 分後の承認で Windows Hello または Touch ID を再要求される
- Workflow run の再実行でも新しい承認を要求する
