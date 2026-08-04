# 必須セットアップ

この文書の作業を完了するまで承認機構は動きません。プレースホルダーを残した Worker は承認を拒否します。

## 最初に確認すること

- リポジトリを Public にする
- 既定ブランチを main にする
- 通常利用者の権限を Write 以下にする
- Maintain、Admin、Organization Owner は侵害時に設定を変更できると理解する
- break-glass 用管理者と Cloudflare 管理者の認証を承認専用認証と分離する
- Node.js 24 と pnpm 10 を用意する
- OpenSSL を用意する
- `voicevox.oss@gmail.com` が One-time PIN で Access にログインできるようにする

GitHub の custom deployment protection rule は Public Preview です。本番移行前に再実行を含む試験が必要です。

個人リポジトリの所有者は Admin から下げられません。このリポジトリを個人アカウントで試す間は仕組みの動作確認に限定します。通常利用アカウントの侵害に耐える本番構成では Organization へ移し、通常利用アカウントを Write 以下にして、別の break-glass 用アカウントだけを Owner にします。

このプロトタイプで使う値は確定済みです。

- Zero Trust team domain は `https://voicevox-oss-01.cloudflareaccess.com`
- 承認用ホスト名は `github-pages-deployment-approval.voicevox-oss.workers.dev`
- 承認専用メールアドレスは `voicevox.oss@gmail.com`
- 承認用認証器は Windows Hello と macOS Touch ID

Windows Hello と Touch ID は Cloudflare 上では Security key ではなく Biometrics に分類されます。どちらも端末内蔵の WebAuthn platform authenticator です。Windows Hello は端末設定によって PIN でも認証できるため、指紋や顔だけを必須にはできません。このプロトタイプは取り外し可能な物理セキュリティキーを必須にする元の要件とは異なります。

独自ドメインは不要です。Cloudflare Access は `workers.dev` hostname に明示的に設定できます。`workers.dev` は試験用途向けのため、本番運用へ移す場合は Cloudflare で管理する独自ドメインへ変更します。

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

## Worker を準備する

`wrangler.jsonc` には次の非機密情報を設定済みです。

- `EXPECTED_WORKFLOW_SHA` は production の先頭コミット `aba78a32b177696ecfe258155ecbd7d1eb1c1424`
- `ACCESS_TEAM_DOMAIN` は `https://voicevox-oss-01.cloudflareaccess.com`
- `APPROVER_EMAIL` は `voicevox.oss@gmail.com`
- `GITHUB_APP_CLIENT_ID` は `Iv23liFVBGJBRsob9dZr`
- `workers_dev` は有効
- `preview_urls` は無効

`ACCESS_AUD` は後で作る Access application の AUD tag へ置き換えます。

このリポジトリでは `ALLOWED_REPOSITORY_ID` を現在の ID `1320267202` に固定しています。別リポジトリへコピーした場合は GitHub API で数値 ID を取得して変更します。名前だけを信頼してはいけません。

`ACCESS_AUD` は Access application の作成前には取得できません。初回デプロイだけはゼロのプレースホルダーを残します。この時点の Worker は作成用であり、`/health` は失敗し、承認要求も拒否します。

Wrangler の認証先が想定した Cloudflare account であることを確認します。未ログインまたは別の account なら `pnpm wrangler login` を実行してから再確認します。

```shell
pnpm wrangler whoami
```

依存関係、生成型、静的検査を確認します。

Worker のデプロイは、内容を確認したローカル checkout から信頼できる管理者が実行します。Cloudflare API token を GitHub Actions やこのリポジトリへ渡してはいけません。

```shell
pnpm install --frozen-lockfile
pnpm run worker:types
pnpm run check
```

`wrangler.jsonc` は3個の必須 Secret を宣言しています。新規 Worker は `wrangler secret put` より先に作れないため、初回デプロイでは3個を Secret ファイルから同時に登録します。

GitHub App の private key を PKCS#8 に変換します。入力元と出力先はリポジトリの外に置きます。

```shell
openssl pkcs8 -topk8 -nocrypt \
  -in /安全な場所/github-app-private-key.pem \
  -out /安全な場所/github-app-private-key.pkcs8.pem
```

リポジトリ直下に一時ファイル `.env.initial-deploy` を作り、次の形式で値を入力します。このファイルは `.gitignore` の `.env.*` に一致しますが、Git の状態も必ず確認します。

```dotenv
DECISION_TOKEN_SECRET="パスワードマネージャーで生成した32文字以上の値"
GITHUB_WEBHOOK_SECRET="GitHub Appに設定したWebhook secret"
GITHUB_APP_PRIVATE_KEY="""
-----BEGIN PRIVATE KEY-----
PKCS#8へ変換したprivate key
-----END PRIVATE KEY-----
"""
```

Secretファイルを指定して初回デプロイします。KV namespace は Wrangler が binding から自動作成します。

```shell
pnpm wrangler deploy --secrets-file .env.initial-deploy
```

デプロイ成功後すぐに `.env.initial-deploy` を削除します。初回デプロイでは Wrangler が KV namespace を自動作成します。非対話デプロイで `wrangler.jsonc` に ID が書き戻されなかった場合は、デプロイ結果に表示された ID を `kv_namespaces` へ設定します。`pnpm run worker:types` を再実行し、KV ID と型定義を以後の checkout でも維持します。

Worker の URL は `https://github-pages-deployment-approval.voicevox-oss.workers.dev` です。初回デプロイ後に Cloudflare Access をこの hostname の承認 URL だけへ設定します。

初回デプロイ後に Secret を更新するときは対話入力します。

```shell
pnpm wrangler secret put DECISION_TOKEN_SECRET
pnpm wrangler secret put GITHUB_WEBHOOK_SECRET
openssl pkcs8 -topk8 -nocrypt -in github-app-private-key.pem |
  pnpm wrangler secret put GITHUB_APP_PRIVATE_KEY
```

各値の意味は次のとおりです。

- `DECISION_TOKEN_SECRET` はパスワードマネージャーで生成した32文字以上の別の値
- `GITHUB_WEBHOOK_SECRET` は GitHub App に設定した Webhook secret と同じ値
- `GITHUB_APP_PRIVATE_KEY` は GitHub App の private key を PKCS#8 へ変換した PEM 全文

GitHub からダウンロードした秘密鍵はリポジトリの外へ置きます。更新時は `openssl pkcs8` の出力をファイルへ保存せず Wrangler に渡します。

値をコマンド引数へ書かず、通常の Secret は対話入力を使います。Secret と秘密鍵をリポジトリ、`.env`、`wrangler.jsonc`、GitHub Actions に永続保存してはいけません。一時 Secret ファイルは初回デプロイ直後に削除します。

## Cloudflare Access を設定する

One-time PIN と App Launcher を次の順に設定します。Cloudflare dashboard は日本語表示でも一部の項目名が英語になることがあります。

1. Zero Trust の Integrations、Identity providers を開く。
2. Add new identity provider から One-time PIN を追加して保存する。
3. Access controls、Access settings の Manage your App Launcher で Manage を選ぶ。
4. Policies タブで「新しいポリシーの作成」を選ぶ。
5. ポリシー名を `承認者のみ`、アクションを Allow にする。
6. Include のセレクターで Emails を選び、値を `voicevox.oss@gmail.com` にする。
7. Require と Exclude は追加せず、ポリシーを保存する。
8. Authentication タブを開き、One-time PIN だけを選んで保存する。

One-time PIN は最初の本人認証に使う login method です。後で設定する Windows Hello と Touch ID は、このログイン後に要求する independent MFA です。

`https://voicevox-oss-01.cloudflareaccess.com` を開き、`voicevox.oss@gmail.com` を入力して Send login code を選びます。メールで届いた PIN を入力できれば本人認証は成功です。PIN の入力後に利用可能な application がないという画面が出ても、Access application をまだ作成していない段階では問題ありません。

MFA device の登録画面は、管理者向けの Manage your App Launcher にはありません。ログインした利用者が App Launcher の Account、MFA devices から開く画面です。application がない段階では、次の直接 URL を使います。

`https://voicevox-oss-01.cloudflareaccess.com/AddMfaDevice`

Windows Hello と Touch ID を両方登録するには、一時的な TOTP を登録確認用に使います。別端末で認証器を追加するときは、登録済みの independent MFA device による確認が必要なためです。承認 application を有効にする前に TOTP を削除します。

1. Zero Trust の Access controls、Access settings で independent MFA を有効にする。
2. Allowed MFA methods は一時的に Authenticator application と Biometrics を許可する。
3. Use identity provider MFA は無効にする。
4. Authentication duration は Require every login にする。
5. Windows で `https://voicevox-oss-01.cloudflareaccess.com/AddMfaDevice` を開き、Authenticator application を最初に登録する。
6. 同じ URL を Windows で開き、TOTP で変更を確認して Biometrics、Register biometrics、Add Windows Hello を選ぶ。
7. 同じ URL を macOS で開き、TOTP で変更を確認して Biometrics、Register biometrics、Add macOS Touch ID を選ぶ。
8. Windows Hello または Touch ID で変更を確認し、一時的な TOTP を削除する。
9. Zero Trust の Team & Resources、Users で `voicevox.oss@gmail.com` を選び、MFA devices が Windows Hello と Touch ID の2個だけであることを確認する。
10. Access settings の Allowed MFA methods を Biometrics だけに変更する。

AAGUID の許可リストは設定しません。Windows Hello と Touch ID は端末ごとの platform authenticator であり、今回の情報だけでは固定すべき AAGUID を決められないためです。登録時には OS の認証画面が出たことを確認し、認証器名に端末名を付けます。

初回デプロイ後、Cloudflare dashboard の Workers & Pages で `github-pages-deployment-approval` を選びます。Settings、Domains & Routes、workers.dev の順に開き、Enable Cloudflare Access を選びます。その後に Manage Access から自動作成された application を編集します。

- Public hostname は `github-pages-deployment-approval.voicevox-oss.workers.dev`
- Path は `/approval/authorize/*`
- Allow policy の Include は Emails を選び、`voicevox.oss@gmail.com` だけを指定
- Bypass policy は作らない
- 同じ hostname と path に重なる別の Access application を作らない
- Application の Session Duration は Immediate timeout
- Allow policy の Session Duration も Immediate timeout
- Application と Allow policy の MFA は Custom MFA settings
- Allowed MFA methods は Biometrics だけ
- Authentication duration は Require every login
- Authenticate with Cloudflare One Client は無効

MFA の Require every login は Access のログイン時だけ評価されます。既存の application session を残さないため、Application と Allow policy の Session Duration も Immediate timeout にします。Cloudflare One Client session はこの設定より優先されるため、この application では有効にしません。

保護対象は `/approval/authorize/*` の GET だけです。この1リクエストで2分間有効な署名済み決定トークンを発行します。`/approval/decision/*` の POST は Access の外ですが、Worker が HMAC、期限、run ID、試行回数、リポジトリ ID、Deployment ID、GitHub の現在の状態を検証します。

`/github/webhook` は Access の対象外です。GitHub の `X-Hub-Signature-256` を Worker が検証します。Worker hostname 全体を Access で保護すると GitHub Webhook まで遮断するため、必ず path を限定します。

Access application の AUD tag を `wrangler.jsonc` の `ACCESS_AUD` に設定し、Worker を再デプロイします。

```shell
pnpm run worker:types
pnpm run check
pnpm wrangler deploy
```

Worker のトップページと `/health` が応答することを確認します。`/health` が `200` と `{"status":"ok"}` を返せば、必須設定と Secret の形式検証は成功です。その後、github-pages Environment の Deployment protection rules で Approval GitHub App を有効化します。

## デプロイを実行する

main から公開したい40文字のコミット SHA を選びます。Workflow はその SHA が現在の main から到達可能かを、依存関係の実行前に検証します。

GitHub Actions の画面で `固定 GitHub Pages デプロイ` を選び、実行 branch に production、入力にソース SHA を指定します。CLI を使う場合は次の形です。

```shell
gh workflow run .github/workflows/deploy-pages.yml \
  --ref production \
  --field source_sha=公開する40文字のコミットSHA
```

ビルド job は Environment、Pages write、ID token、Worker Secret を持ちません。ビルドが成功すると deploy job が github-pages Environment で待機します。

承認用 Worker のトップページを開き、対象 run を選びます。Cloudflare Access で Windows Hello または Touch ID を完了した後に、リポジトリ、Workflow、ref、Workflow SHA、Environment、ソース SHA を確認して承認します。

## 本番利用前に必ず試験する

- main ref から Workflow を実行して deploy job が開始しないこと
- production 以外を github-pages Environment が拒否すること
- `EXPECTED_WORKFLOW_SHA` と異なる run を Worker が拒否すること
- 別の Workflow パス、Environment、リポジトリ ID を Worker が拒否すること
- Webhook secret が異なる要求を Worker が拒否すること
- 決定トークンが2分後に失効すること
- Windows と macOS から承認し、それぞれ Windows Hello と Touch ID を要求されること
- 同じブラウザで2回続けて承認し、どちらでも端末内蔵認証器を要求されること
- Windows Hello の PIN が許可される端末では、PIN でも認証できることを既知の制約として記録すること
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

production と `EXPECTED_WORKFLOW_SHA` の更新間は承認が失敗します。古い SHA と新しい SHA を同時に許可してはいけません。
