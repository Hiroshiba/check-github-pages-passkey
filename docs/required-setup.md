# 必須セットアップ

この文書の作業を完了するまで承認機構は動きません。プレースホルダーを残した Worker は承認を拒否します。

## 最初に確認すること

- リポジトリを Public にする
- 既定ブランチを main にする
- 通常利用者の権限を Write 以下にする
- Maintain、Admin、Organization Owner は侵害時に設定を変更できると理解する
- break-glass 用管理者と Cloudflare 管理者の認証を承認専用認証と分離する
- Node.js 24、pnpm 10、Terraform 1.14、OpenSSL を用意する
- `voicevox.oss@gmail.com` と `hihokaruta@gmail.com` が One-time PIN を受信できることを確認する

GitHub の custom deployment protection rule は Public Preview です。本番移行前に再実行を含む試験が必要です。

個人リポジトリの所有者は Admin から下げられません。このリポジトリを個人アカウントで試す間は仕組みの動作確認に限定します。本番構成では Organization へ移し、通常利用アカウントを Write 以下にして、別の break-glass 用アカウントだけを Owner にします。

このリポジトリでは次の値を使います。

- Zero Trust team domain は `https://voicevox-oss-01.cloudflareaccess.com`
- 承認用ホスト名は `github-pages-deployment-approval.voicevox-oss.workers.dev`
- 承認用認証器は Windows Hello と macOS Touch ID

Windows Hello と Touch ID は Cloudflare 上では Biometrics に分類されます。Windows Hello は端末設定によって PIN でも認証できるため、指紋や顔だけを必須にはできません。取り外し可能な物理セキュリティキーだけを必須にする構成ではありません。

## main と production を準備する

1. この実装を main に反映する。
2. 内容を確認した main のコミットから production ブランチを作る。
3. production の先頭コミット SHA を記録する。
4. `.github/workflows/deploy-pages.yml` が main と production の同じパスに存在することを確認する。

`workflow_dispatch` は定義ファイルが既定ブランチに存在しないと起動できません。main 上のファイルは起動入口として必要です。デプロイ時に信頼するのは production ref 上の固定ファイルです。

production 用 branch ruleset を Repository settings の Rules から作成します。

- 対象ブランチは `production` だけ
- Enforcement status は Active
- Restrict creations を有効化
- Restrict updates を有効化
- Restrict deletions を有効化
- Block force pushes を有効化
- 通常利用者や Approval App を bypass actor に追加しない

production の作成後に Restrict creations を有効化します。固定 Workflow を変更するときだけ break-glass 管理者が ruleset を変更し、作業後すぐ元へ戻します。

## GitHub Pages と Environment を設定する

Repository settings の Pages で Source を GitHub Actions にします。

Repository settings の Environments で `github-pages` を作り、次を設定します。

- Deployment branches and tags は Selected branches and tags
- 許可する branch pattern は `production` だけ
- GitHub Pages が自動追加した `main` の branch pattern があれば削除
- tag pattern は追加しない
- 管理者による protection rule の bypass を禁止
- Environment secret は作成しない

Workflow 内の `if` は補助的な拒否です。セキュリティ境界は Environment の deployment branch rule です。

## Approval GitHub App を作る

GitHub App を1個作り、次だけを設定します。

- Homepage URL は `https://github.com/Hiroshiba/check-github-pages-passkey`
- Actions repository permission は Read-only
- Deployments repository permission は Read and write
- User authorization は使わない
- Deployment protection rule event を購読
- Webhook URL は `https://github-pages-deployment-approval.voicevox-oss.workers.dev/github/webhook`
- Webhook secret はパスワードマネージャーで生成した32文字以上の値
- SSL verification は有効
- Webhook は Active
- Where can this GitHub App be installed は Only on this account
- インストール先は `Hiroshiba/check-github-pages-passkey` だけ

Contents、Actions write、Pages、Administration の権限は付けません。App の Client ID とダウンロードした private key を安全な場所に保管します。秘密鍵ファイルはリポジトリの外へ置きます。

App を対象リポジトリへインストールします。Deployment protection rules での有効化は Worker の設定完了後に行います。

## Cloudflare を Terraform へ取り込む

Cloudflare 管理者が対象 account だけに限定した API token を作ります。次の read と write 権限が必要です。

- Access: Apps and Policies
- Access: Organizations, Identity Providers, and Groups
- Workers KV Storage

Dashboard の My Profile、API Tokens から Create Token、Custom token の順に選びます。3個の Account permission は Edit にし、Account Resources は対象 account だけを Include します。作業時間に合わせた TTL を設定し、作成後に一度だけ表示される token をパスワードマネージャーへ保存します。

Cloudflare account ID と token を環境変数へ設定します。値をコマンド引数やリポジトリへ保存しません。

```shell
read -rsp "Cloudflare API token: " CLOUDFLARE_API_TOKEN
export CLOUDFLARE_API_TOKEN
printf '\n'
export TF_VAR_cloudflare_account_id="32文字のCloudflare account ID"
terraform -chdir=terraform/cloudflare init
terraform -chdir=terraform/cloudflare plan -out=cloudflare.tfplan
terraform -chdir=terraform/cloudflare show cloudflare.tfplan
terraform -chdir=terraform/cloudflare apply cloudflare.tfplan
terraform -chdir=terraform/cloudflare output
```

既存の Access application、App Launcher、One-time PIN、KV namespace は自動で state へ import されます。Zero Trust organization は import 非対応のため既存でも create と表示され、現在の endpoint を更新して state に入ります。2個の reusable policy も新規作成され、既存 application の policy と置き換わります。それ以外に create が表示された場合や、destroy や置換がある場合は apply しません。account ID、token の対象 account、`wrangler.jsonc` の AUD と KV ID を確認します。

Terraform は organization 全体への MFA 適用を無効にし、通常の既定時間を24時間にします。承認 application と policy だけが15分のセッションと Biometrics MFA を要求します。One-time PIN は organization の SSO セッションにより15分後も省略される場合がありますが、Windows Hello または Touch ID は15分後に再要求されます。

詳しい管理境界と移行時の確認項目は [Cloudflare Terraform 運用](cloudflare-terraform.md)にあります。

## MFA device を登録する

Terraform 適用後、承認者ごとに次の操作が必要です。この操作は本人の認証器を使うため自動化できません。

1. `https://voicevox-oss-01.cloudflareaccess.com/AddMfaDevice` を開く。
2. 自分のメールアドレスと One-time PIN でログインする。
3. Biometrics、Register biometrics の順に選ぶ。
4. Windows Hello または Touch ID を登録する。
5. 認証器名に端末を識別できる名前を付ける。
6. Cloudflare の Team & Resources、Users で登録内容を確認する。

最初の MFA device の登録では既存 device による確認はありません。承認者を Access policy へ追加してから本人が登録するまでの時間を短くします。

同じ承認者が別端末の platform authenticator を追加する場合は、登録済み device による確認が必要です。端末をまたいで確認できない場合だけ、organization の `allowed_authenticators` に `totp` を一時追加して Terraform を適用します。TOTP を使って別端末を登録した後、TOTP device を削除し、Terraform の許可を Biometrics だけへ戻します。承認 policy は作業中も Biometrics だけを許可します。

AAGUID の許可リストは設定しません。Windows Hello と Touch ID の AAGUID を今回の情報だけでは固定できないためです。

## Worker を準備する

Terraform の出力と `wrangler.jsonc` の `ACCESS_AUD` と KV namespace ID が一致することを確認します。不一致が報告された場合は Terraform の出力値へ更新します。

`wrangler.jsonc` の次の値も確認します。

- `EXPECTED_WORKFLOW_SHA` は production の先頭コミット
- `ALLOWED_REPOSITORY_ID` は GitHub API が返す数値 ID
- `GITHUB_APP_CLIENT_ID` は作成した GitHub App の Client ID
- `ALLOWED_APPROVER_EMAILS` は承認を許可する全メールアドレス

Wrangler の認証先を確認し、依存関係と静的検査を実行します。

```shell
pnpm wrangler whoami
pnpm install --frozen-lockfile
pnpm run worker:types
pnpm run check
```

Worker のデプロイは、内容を確認したローカル checkout から信頼できる管理者が実行します。Cloudflare API token を GitHub Actions やこのリポジトリへ渡しません。

GitHub App の private key を PKCS#8 に変換します。入力元と出力先はリポジトリの外に置きます。

```shell
openssl pkcs8 -topk8 -nocrypt \
  -in /安全な場所/github-app-private-key.pem \
  -out /安全な場所/github-app-private-key.pkcs8.pem
```

リポジトリ直下に一時ファイル `.env.initial-deploy` を作り、3個の Secret を入力します。このファイルは `.gitignore` の対象ですが、Git の状態も必ず確認します。

```dotenv
DECISION_TOKEN_SECRET="パスワードマネージャーで生成した32文字以上の値"
GITHUB_WEBHOOK_SECRET="GitHub Appに設定したWebhook secret"
GITHUB_APP_PRIVATE_KEY="""
-----BEGIN PRIVATE KEY-----
PKCS#8へ変換したprivate key
-----END PRIVATE KEY-----
"""
```

```shell
pnpm wrangler deploy --secrets-file .env.initial-deploy
```

デプロイ成功後すぐに `.env.initial-deploy` を削除します。Secret と秘密鍵をリポジトリ、Terraform state、`wrangler.jsonc`、GitHub Actions に永続保存しません。

Secret の更新には対話入力を使います。

```shell
pnpm wrangler secret put DECISION_TOKEN_SECRET
pnpm wrangler secret put GITHUB_WEBHOOK_SECRET
openssl pkcs8 -topk8 -nocrypt -in /安全な場所/github-app-private-key.pem |
  pnpm wrangler secret put GITHUB_APP_PRIVATE_KEY
```

Worker のトップページと `/health` を確認します。`/health` が `200` と `{"status":"ok"}` を返した後、github-pages Environment の Deployment protection rules で Approval GitHub App を有効化します。

## 承認者を変更する

承認者の追加では `wrangler.jsonc` の `ALLOWED_APPROVER_EMAILS` だけを編集します。Terraform を先に適用し、Worker を後からデプロイします。その後、承認者本人が MFA device を登録します。

承認者の削除では同じ一覧からメールアドレスを削除し、Worker を先にデプロイしてから Terraform を適用します。

順序の理由とコマンドは [Cloudflare Terraform 運用](cloudflare-terraform.md)を参照してください。

## デプロイを実行する

main から公開したい40文字のコミット SHA を選びます。Workflow はその SHA が現在の main から到達可能かを、依存関係の実行前に検証します。

GitHub Actions の画面で `固定 GitHub Pages デプロイ` を選び、実行 branch に production、入力にソース SHA を指定します。CLI では次の形です。

```shell
gh workflow run .github/workflows/deploy-pages.yml \
  --ref production \
  --field source_sha=公開する40文字のコミットSHA
```

ビルド job は Environment、Pages write、ID token、Worker Secret を持ちません。ビルドが成功すると deploy job が github-pages Environment で待機します。

承認用 Worker のトップページを開き、対象 run を選びます。Cloudflare Access の MFA セッションが切れている場合は Windows Hello または Touch ID を完了します。リポジトリ、Workflow、ref、Workflow SHA、Environment、ソース SHA を確認して承認します。

## 本番利用前に必ず試験する

- main ref から Workflow を実行して deploy job が開始しないこと
- production 以外を github-pages Environment が拒否すること
- `EXPECTED_WORKFLOW_SHA` と異なる run を Worker が拒否すること
- 別の Workflow パス、Environment、リポジトリ ID を Worker が拒否すること
- Webhook secret が異なる要求を Worker が拒否すること
- 決定トークンが2分後に失効すること
- Windows と macOS から承認し、それぞれ Windows Hello と Touch ID を要求されること
- 同じブラウザで認証後15分以内に再承認し、MFA なしで承認画面へ進めること
- 15分経過後に再承認し、Windows Hello または Touch ID を要求されること
- Windows Hello の PIN が許可される端末では PIN でも認証できることを既知の制約として記録すること
- Workflow run の再実行でも新しい承認を要求すること
- 承認後に同じトークンを再送してもデプロイ状態が変わらないこと
- production ruleset に通常利用者の bypass がないこと
- github-pages Environment で管理者 bypass が禁止されていること
- GitHub の Webhook deliveries、Access logs、Workers Logs に成功と拒否が記録されること

Custom deployment protection rule は Public Preview のため、GitHub の仕様変更時は payload schema と review API を再確認します。

## production の固定 Workflow を更新する

production の更新は通常運用にしません。更新が必要な場合は次をすべて行います。

1. break-glass 管理者で変更内容と Actions の固定 SHA をレビューする。
2. production ruleset を一時的に変更する。
3. production を更新して新しい先頭コミット SHA を記録する。
4. ruleset を元へ戻す。
5. `EXPECTED_WORKFLOW_SHA` を新しい SHA に変更する。
6. Worker を再デプロイする。
7. 拒否試験と正常な承認試験をやり直す。

production と `EXPECTED_WORKFLOW_SHA` の更新間は承認が失敗します。古い SHA と新しい SHA を同時に許可しません。
