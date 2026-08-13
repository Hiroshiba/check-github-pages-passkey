# 必須セットアップ

この文書は、本人または管理者による初回作業だけをまとめます。通常の Cloudflare 更新は [Cloudflare デプロイ](cloudflare-terraform.md)に従って GitHub Workflow から実行します。

## 最初に確認すること

- リポジトリを Public にする
- 既定ブランチを main にする
- 通常利用者の権限を Write 以下にする
- Maintain、Admin、Organization Owner は侵害時に設定を変更できると理解する
- break-glass 用管理者と Cloudflare 管理者の認証を承認専用認証と分離する
- Node.js 24、pnpm 10、Terraform 1.14、OpenSSL を用意する
- Cloudflare Zero Trust を開始し、team domain を作成する
- `voicevox.oss@gmail.com` と `hihokaruta@gmail.com` が One-time PIN を受信できることを確認する

GitHub の custom deployment protection rule は Public Preview です。本番移行前に再実行を含む試験が必要です。

個人リポジトリの所有者は Admin から下げられません。このリポジトリを個人アカウントで試す間は仕組みの動作確認に限定します。本番構成では Organization へ移し、通常利用アカウントを Write 以下にして、別の break-glass 用アカウントだけを Owner にします。

このリポジトリでは次の値を使います。

- Zero Trust team domain は `https://voicevox-oss-01.cloudflareaccess.com`
- 承認用ホスト名は `github-pages-deployment-approval.voicevox-oss.workers.dev`
- 承認用認証器は Windows Hello と macOS Touch ID

Windows Hello と Touch ID は Cloudflare 上では Biometrics に分類されます。Windows Hello は端末設定によって PIN でも認証できます。取り外し可能な物理セキュリティキーだけを必須にする構成ではありません。

## main と production を準備する

1. この実装を main に反映する。
2. 内容を確認した main のコミットから production ブランチを作る。
3. production の先頭コミット SHA を記録する。
4. `.github/workflows/deploy-pages.yml` と `.github/workflows/deploy-cloudflare.yml` が main と production の同じパスに存在することを確認する。
5. main の `wrangler.jsonc` にある `EXPECTED_WORKFLOW_SHA` を記録した SHA へ更新する。

`workflow_dispatch` は定義ファイルが既定ブランチに存在しないと起動できません。main 上のファイルは起動入口として必要です。実行時に信頼する Workflow 定義は production ref 上の固定ファイルです。

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

Workflow 内の ref 検証は補助的な拒否です。セキュリティ境界は Environment の deployment branch rule です。

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

## Cloudflare デプロイを準備する

Cloudflare Dashboard の R2 で `check-github-pages-passkey-terraform-state` bucket を作ります。Manage R2 API Tokens から、この bucket だけに Object Read and Write を許可する token を作ります。一度だけ表示される Access Key ID と Secret Access Key をパスワードマネージャーへ保存します。

対象 account だけを Include した Cloudflare API token を2個作ります。plan 用 token には次の Read 権限を設定します。

- Access: Apps and Policies Read
- Access: Organizations, Identity Providers, and Groups Read
- Workers KV Storage Read

production 用 token には次の権限を設定します。

- Access: Apps and Policies Edit
- Access: Organizations, Identity Providers, and Groups Edit
- Workers KV Storage Edit
- Workers Scripts Edit
- Account Settings Read

Token 名には用途を含め、有効期限とローテーション日を記録します。Token の値はパスワードマネージャー以外へ保存しません。

Repository settings の Actions、Variables で `CLOUDFLARE_ACCOUNT_ID` を repository variable として作ります。32文字の小文字16進数で設定します。

Repository settings の Environments で `cloudflare-plan` と `cloudflare-production` を作ります。両方に次を設定します。

- Deployment branches and tags は Selected branches and tags
- 許可する branch pattern は `production` だけ
- required reviewer を設定
- Prevent self-review を有効化
- 管理者による protection rule の bypass を禁止

別の reviewer を用意できない個人検証では、Environment 承認を独立した信頼境界として再現できません。

Environment secret は次の対応で設定します。

| Secret                 | cloudflare-plan      | cloudflare-production     |
| ---------------------- | -------------------- | ------------------------- |
| `CLOUDFLARE_API_TOKEN` | plan 用 token        | production 用 token       |
| `R2_ACCESS_KEY_ID`     | R2 Access Key ID     | 同じ R2 Access Key ID     |
| `R2_SECRET_ACCESS_KEY` | R2 Secret Access Key | 同じ R2 Secret Access Key |

plan の承認者は、資格情報を渡す前に指定ソースの差分を確認します。production の承認者は plan job のログを確認します。Approval GitHub App は自分自身の更新を承認させないため、この2個の Environment では使いません。

local state が既にある場合は [State と復旧](cloudflare-terraform.md#state-と復旧)に従い、最初の Workflow 実行前に R2 へ移行します。

## Worker Secret を初回登録する

既存 Worker に次の Secret が登録済みなら、この作業は不要です。

- `DECISION_TOKEN_SECRET`
- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_APP_PRIVATE_KEY`

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
pnpm install --frozen-lockfile
pnpm wrangler deploy --secrets-file .env.initial-deploy
```

デプロイ成功後すぐに `.env.initial-deploy` を削除します。Secret と秘密鍵をリポジトリ、Terraform state、`wrangler.jsonc`、GitHub Actions に保存しません。通常の Workflow デプロイは Cloudflare に登録済みの Secret を保持します。

新しい Cloudflare account で AUD または KV namespace ID の不一致が報告された場合は、[初回 plan](cloudflare-terraform.md#初回-plan)に従います。

Secret の更新には対話入力を使います。

```shell
pnpm wrangler secret put DECISION_TOKEN_SECRET
pnpm wrangler secret put GITHUB_WEBHOOK_SECRET
openssl pkcs8 -topk8 -nocrypt -in /安全な場所/github-app-private-key.pem |
  pnpm wrangler secret put GITHUB_APP_PRIVATE_KEY
```

## Cloudflare と MFA を有効にする

main からデプロイするコミット SHA を選び、[GitHub Workflow](cloudflare-terraform.md#github-workflow)に従って `固定 Cloudflare デプロイ` を production ref から実行します。`cloudflare-plan` ではソースを確認し、`cloudflare-production` では plan を確認して承認します。

Terraform 適用後、承認者ごとに次の操作が必要です。この操作は本人の認証器を使うため自動化できません。

1. `https://voicevox-oss-01.cloudflareaccess.com/AddMfaDevice` を開く。
2. 自分のメールアドレスと One-time PIN でログインする。
3. Biometrics、Register biometrics の順に選ぶ。
4. Windows Hello または Touch ID を登録する。
5. 認証器名に端末を識別できる名前を付ける。
6. Cloudflare の Team & Resources、Users で登録内容を確認する。

最初の MFA device の登録では既存 device による確認がありません。承認者を Access policy へ追加してから本人が登録するまでの時間を短くします。

同じ承認者が別端末の platform authenticator を追加する場合は、登録済み device による確認が必要です。端末をまたいで確認できない場合だけ、organization の `allowed_authenticators` に `totp` を一時追加して Terraform を適用します。TOTP を使って別端末を登録した後、TOTP device を削除し、Terraform の許可を Biometrics だけへ戻します。承認 policy は作業中も Biometrics だけを許可します。

AAGUID の許可リストは設定しません。Windows Hello と Touch ID の AAGUID を今回の情報だけでは固定できないためです。

Worker のトップページと `/health` を確認します。`/health` が `200` と `{"status":"ok"}` を返した後、github-pages Environment の Deployment protection rules で Approval GitHub App を有効化します。

## GitHub Pages をデプロイする

main から公開したい40文字のコミット SHA を選びます。Workflow はその SHA が現在の main から到達可能かを、依存関係の実行前に検証します。

GitHub Actions の画面で `固定 GitHub Pages デプロイ` を選び、実行 branch に production、入力にソース SHA を指定します。

```shell
gh workflow run .github/workflows/deploy-pages.yml \
  --ref production \
  --field source_sha=公開する40文字のコミットSHA
```

ビルド job は Environment、Pages write、ID token、Worker Secret を持ちません。ビルドが成功すると deploy job が github-pages Environment で待機します。

承認用 Worker のトップページを開き、対象 run を選びます。Cloudflare Access の MFA セッションが切れている場合は Windows Hello または Touch ID を完了します。リポジトリ、Workflow、ref、Workflow SHA、Environment、ソース SHA を確認して承認します。

## 本番利用前に試験する

- main ref から両方の固定 Workflow を実行して拒否されること
- production 以外を3個の Environment が拒否すること
- Cloudflare plan と apply が別々の承認を要求すること
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
- 3個の Environment で管理者 bypass が禁止されていること
- GitHub の Webhook deliveries、Access logs、Workers Logs に成功と拒否が記録されること

Custom deployment protection rule は Public Preview のため、GitHub の仕様変更時は payload schema と review API を再確認します。

## production の固定 Workflow を更新する

production の更新は通常運用にしません。更新が必要な場合は次をすべて行います。

1. break-glass 管理者で変更内容と Actions の固定 SHA をレビューする。
2. production ruleset を一時的に変更する。
3. production を更新して新しい先頭コミット SHA を記録する。
4. ruleset を元へ戻す。
5. main の `EXPECTED_WORKFLOW_SHA` を新しい SHA に変更する。
6. `固定 Cloudflare デプロイ` で Worker を更新する。
7. 拒否試験と正常な承認試験をやり直す。

production と `EXPECTED_WORKFLOW_SHA` の更新間は GitHub Pages の承認が失敗します。古い SHA と新しい SHA を同時に許可しません。
