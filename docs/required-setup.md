# 必須セットアップ

この文書は、初回導入と導入結果の確認だけを扱います。上から順に実行してください。

## 前提を確認する

- リポジトリを Public にする
- 既定ブランチを main にする
- 通常利用者の権限を Write 以下にする
- break-glass 用管理者と Cloudflare 管理者の認証を承認専用認証と分離する
- Node.js 24、pnpm 10、Terraform 1.14、OpenSSL、GitHub CLI を用意する
- Cloudflare Zero Trust を開始し、team domain を作成する
- `voicevox.oss@gmail.com` と `hihokaruta@gmail.com` が One-time PIN を受信できることを確認する

個人リポジトリの所有者は Admin から下げられません。個人アカウントでは仕組みの動作確認に限定します。本番では Organization へ移し、通常利用アカウントを Write 以下にして、別の break-glass 用アカウントだけを Owner にします。

`terraform/settings.json` の次の値を導入先に合わせます。

- `cloudflare_account_id` は Cloudflare account ID
- `github_environment_reviewer_logins` はインフラ変更を承認する GitHub login の一覧

reviewer は 1 人以上 6 人以下で、リポジトリへの Read 権限が必要です。Workflow の実行者と別の reviewer が承認できるようにします。

`wrangler.jsonc` の次の値も導入先に合わせます。

- `ACCESS_TEAM_DOMAIN`
- `ALLOWED_APPROVER_EMAILS`
- `ALLOWED_REPOSITORY`
- `ALLOWED_REPOSITORY_ID`
- `GITHUB_APP_CLIENT_ID`

`ACCESS_AUD` と `DEPLOYMENT_REQUESTS` の KV namespace ID は最初の Cloudflare Terraform 適用で決まるため、適用後に設定します。

このリポジトリでは次の値を使います。

- Zero Trust team domain は `https://voicevox-oss-01.cloudflareaccess.com`
- 承認用ホスト名は `github-pages-deployment-approval.voicevox-oss.workers.dev`
- 承認用認証器は Windows Hello と macOS Touch ID

Windows Hello と Touch ID は Cloudflare では Biometrics に分類されます。Windows Hello は端末設定によって PIN でも認証できます。取り外し可能な物理セキュリティキーだけを必須にする構成ではありません。

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

Cloudflare Dashboard の R2 で `check-github-pages-passkey-terraform-state` bucket を作ります。Manage R2 API Tokens から、この bucket だけに Object Read and Write を許可する token を作ります。一度だけ表示される Access Key ID と Secret Access Key をパスワードマネージャーへ保存します。

対象 account だけを Include した Cloudflare API token を 2 個作ります。plan 用 token には次の Read 権限を設定します。

- Access: Apps and Policies Read
- Access: Organizations, Identity Providers, and Groups Read
- Workers KV Storage Read

production 用 token には次の権限を設定します。

- Access: Apps and Policies Edit
- Access: Organizations, Identity Providers, and Groups Edit
- Workers KV Storage Edit
- Workers Scripts Edit
- Account Settings Read

GitHub の Fine-grained personal access token を plan 用と production 用に 1 個ずつ作ります。Resource owner と Repository access は対象リポジトリだけに限定します。

| Repository permission | plan      | production     |
| --------------------- | --------- | -------------- |
| Administration        | Read-only | Read and write |
| Contents              | Read-only | Read and write |
| Environments          | Read-only | Read and write |
| Pages                 | Read-only | Read and write |
| Variables             | Read-only | Read and write |

Token 名には用途を含め、有効期限とローテーション日を記録します。Token の値はパスワードマネージャー以外へ保存しません。

## 固定 Workflow を production に置く

1. `terraform/settings.json` と `wrangler.jsonc` の導入先固有値を含む実装を main に反映する。
2. 内容を確認した main のコミットから production ブランチを作る。
3. 3 個の固定 Workflow が main と production の両方に存在することを確認する。
4. production の先頭コミット SHA を記録する。
5. main の `wrangler.jsonc` にある `EXPECTED_WORKFLOW_SHA` を記録した SHA へ更新し、main に反映する。

固定 Workflow は次の 3 個です。

- `.github/workflows/deploy-pages.yml`
- `.github/workflows/deploy-cloudflare.yml`
- `.github/workflows/deploy-github.yml`

production に新しい固定 Workflow を反映するときだけ、break-glass 管理者が現在の ruleset を一時的に無効化します。反映後はすぐ有効に戻します。

`workflow_dispatch` の定義ファイルは既定ブランチにも必要です。main 上のファイルは起動入口として使い、デプロイでは production 上の固定ファイルだけを実行します。

## GitHub Terraform を初回適用する

最初の 1 回は GitHub 設定用 Environment がまだないため、break-glass 管理者がローカルから適用します。

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
terraform -chdir=terraform/github apply github.tfplan
unset GITHUB_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_ENDPOINT_URL
```

plan では次を確認します。

- default branch が main
- production だけに creation、update、deletion、force push の制限がある
- ruleset に bypass actor がない
- GitHub Pages の build type が Workflow
- `github-pages`、`cloudflare-plan`、`cloudflare-production`、`github-plan`、`github-production` が管理対象
- 5 個の Environment が production だけを許可
- 5 個の Environment で管理者 bypass が禁止
- github-pages 以外の Environment で required reviewer と Prevent self-review が有効
- `CLOUDFLARE_ACCOUNT_ID` Actions variable が `terraform/settings.json` と一致
- destroy と意図しない置換がない

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

cloudflare-plan の承認前に指定ソースの差分を確認します。plan では次を確認します。

- destroy と意図しない置換がない
- 保護対象が `/approval/authorize/*` だけ
- organization 全体への MFA 適用が無効
- organization の既定セッションと MFA セッションが 24 時間
- 承認 application と承認 policy のセッションが 15 分
- 承認 policy の MFA method が Biometrics だけ
- App Launcher と承認 policy のメールアドレスが `wrangler.jsonc` と一致
- 作成対象が Zero Trust organization、One-time PIN、App Launcher、承認用 Access application、2 個の reusable policy、Workers KV namespace に限られる

cloudflare-production の承認前に plan job のログを確認します。承認すると同じ plan を適用します。

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

- main ref から 3 個の固定 Workflow を実行すると拒否される
- production 以外を 5 個の Environment が拒否する
- GitHub と Cloudflare の plan と apply がそれぞれ別の承認を要求する
- `EXPECTED_WORKFLOW_SHA` と異なる run を Worker が拒否する
- Windows と macOS から承認すると、それぞれ Windows Hello と Touch ID を要求される
- 認証から 15 分後の承認で Windows Hello または Touch ID を再要求される
- Workflow run の再実行でも新しい承認を要求する
- production ruleset に bypass actor がない
- 5 個の Environment で管理者 bypass が禁止されている
