# 必須セットアップ

この文書の作業を完了するまで承認機構は動きません。プレースホルダーを残した Worker は承認を拒否します。

## 最初に確認すること

- リポジトリを Public にする
- 既定ブランチを main にする
- 通常利用者の権限を Write 以下にする
- Maintain、Admin、Organization Owner は侵害時に設定を変更できると理解する
- break-glass 用管理者と Cloudflare 管理者に物理キーを2本ずつ登録する
- 承認用ホスト名の DNS zone と Zero Trust organization を Cloudflare で準備する
- Node.js 24 と pnpm 10 を用意する
- OpenSSL を用意する
- 承認専用メールアドレスが IdP または One-time PIN で Access にログインできるようにする

GitHub の custom deployment protection rule は Public Preview です。本番移行前に再実行を含む試験が必要です。

個人リポジトリの所有者は Admin から下げられません。このリポジトリを個人アカウントで試す間は仕組みの動作確認に限定します。通常利用アカウントの侵害に耐える本番構成では Organization へ移し、通常利用アカウントを Write 以下にして、別の break-glass 用アカウントだけを Owner にします。

Cloudflare で使う値は次のように準備します。

- Zero Trust team domain は [Cloudflare dashboard](https://dash.cloudflare.com/) の Zero Trust で確認する。未作成ならオンボーディングで team name を決める。team name が `example-team` なら設定値は `https://example-team.cloudflareaccess.com`
- 承認用ホスト名は Cloudflare で管理している DNS zone の未使用サブドメインから決める。例えば `pages-approval.example.com`。DNS レコードは Custom Domain のデプロイ時に Wrangler が作成するため、先に作らない
- 承認専用メールアドレスは Access へのログインに使うアドレスから決める。Cloudflare account と同じアドレスでもよい。別のアドレスを使う場合は IdP または One-time PIN でログインできるようにする
- 物理キーの製品名とモデルは手元の FIDO2 と WebAuthn 対応セキュリティキーから確認する。主キーと予備キーを1本ずつ用意する。Windows Hello、Touch ID、スマートフォン内蔵パスキーは今回の物理キーに含めない

既存 Worker の `workers.dev` ホスト名から Zero Trust team domain や利用可能な DNS zone は特定できません。Cloudflare account を持っているだけでは Zero Trust organization や独自ドメインが作成済みとは限りません。

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
- Webhook URL は `https://承認用ホスト名/github/webhook`
- Webhook secret はパスワードマネージャーで生成した32文字以上の値
- SSL verification は有効
- Webhook は Active
- Where can this GitHub App be installed は Only on this account
- インストール先は `Hiroshiba/check-github-pages-passkey` だけ

Contents、Actions write、Pages、Administration の権限は付けません。App の Client ID とダウンロードした private key を安全な場所に保管します。秘密鍵ファイルはリポジトリの外へ置きます。

App を対象リポジトリへインストールします。Deployment protection rules での有効化は Worker の設定完了後に行います。

## Worker を準備する

`wrangler.jsonc` の次の値を置き換えます。

- `EXPECTED_WORKFLOW_SHA` は記録した production の先頭コミット SHA
- `GITHUB_APP_CLIENT_ID` は Approval GitHub App の Client ID
- `ACCESS_TEAM_DOMAIN` は `https://チーム名.cloudflareaccess.com`
- `ACCESS_AUD` は後で作る Access application の AUD tag

このリポジトリでは `ALLOWED_REPOSITORY_ID` を現在の ID `1320267202` に固定しています。別リポジトリへコピーした場合は GitHub API で数値 ID を取得して変更します。名前だけを信頼してはいけません。

`ACCESS_AUD` は Access application の作成前には取得できません。初回デプロイだけはゼロのプレースホルダーを残します。この時点の Worker は作成用であり、`/health` は失敗し、承認要求も拒否します。

Custom Domain を Wrangler で作る場合は、`wrangler.jsonc` に次の設定を追加します。既存の CNAME と重なるホスト名は使えません。

```jsonc
"routes": [{ "pattern": "承認用ホスト名", "custom_domain": true }],
```

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

`wrangler.jsonc` は4個の必須 Secret を宣言しています。新規 Worker は `wrangler secret put` より先に作れないため、初回デプロイでは4個をSecretファイルから同時に登録します。

GitHub App の private key を PKCS#8 に変換します。入力元と出力先はリポジトリの外に置きます。

```shell
openssl pkcs8 -topk8 -nocrypt \
  -in /安全な場所/github-app-private-key.pem \
  -out /安全な場所/github-app-private-key.pkcs8.pem
```

リポジトリ直下に一時ファイル `.env.initial-deploy` を作り、次の形式で値を入力します。このファイルは `.gitignore` の `.env.*` に一致しますが、Git の状態も必ず確認します。

```dotenv
APPROVER_EMAIL="承認専用メールアドレス"
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

デプロイ成功後すぐに `.env.initial-deploy` を削除します。初回デプロイでは Wrangler が KV namespace の ID を `wrangler.jsonc` に書き戻します。自動変更を確認し、`pnpm run worker:types` を再実行します。生成された KV ID と型定義は以後の checkout でも維持します。

`routes` を使わない場合は、Cloudflare で承認専用の Custom Domain を Worker に割り当てます。GitHub Webhook と Access application は workers.dev ではなくこのホスト名を使います。

`wrangler.jsonc` は workers.dev と preview URL を無効化しています。Custom Domain を割り当てるまで Worker へ外部からアクセスできません。

初回デプロイ後に Secret を更新するときは対話入力します。

```shell
pnpm wrangler secret put APPROVER_EMAIL
pnpm wrangler secret put DECISION_TOKEN_SECRET
pnpm wrangler secret put GITHUB_WEBHOOK_SECRET
openssl pkcs8 -topk8 -nocrypt -in github-app-private-key.pem |
  pnpm wrangler secret put GITHUB_APP_PRIVATE_KEY
```

各値の意味は次のとおりです。

- `APPROVER_EMAIL` は承認専用メールアドレス
- `DECISION_TOKEN_SECRET` はパスワードマネージャーで生成した32文字以上の別の値
- `GITHUB_WEBHOOK_SECRET` は GitHub App に設定した Webhook secret と同じ値
- `GITHUB_APP_PRIVATE_KEY` は GitHub App の private key を PKCS#8 へ変換した PEM 全文

GitHub からダウンロードした秘密鍵はリポジトリの外へ置きます。更新時は `openssl pkcs8` の出力をファイルへ保存せず Wrangler に渡します。

値をコマンド引数へ書かず、通常の Secret は対話入力を使います。Secret と秘密鍵をリポジトリ、`.env`、`wrangler.jsonc`、GitHub Actions に永続保存してはいけません。一時 Secret ファイルは初回デプロイ直後に削除します。

## Cloudflare Access を設定する

Zero Trust の Access controls、Access settings で independent MFA を有効にします。許可する MFA method に Security key を含め、Use identity provider MFA は無効にします。

承認専用メールアドレスで App Launcher にログインできることを確認します。Independent MFA は追加認証であり、IdP または One-time PIN による最初の本人認証を置き換えません。

Zero Trust の Access controls で Self-hosted public hostname application を作ります。

- Hostname は Worker の承認専用 Custom Domain
- Path は `/approval/authorize/*`
- Allow policy の Include は承認専用メールアドレスだけ
- Allow policy の MFA も Custom MFA settings にして Security key と Require every login を設定
- Bypass policy は作らない
- 同じ hostname と path に重なる別の Access application を作らない
- Application の Session Duration は Immediate timeout
- Allow policy の Session Duration も Immediate timeout
- Custom MFA settings を選ぶ
- Allowed MFA methods は Security key だけ
- Authentication duration は Require every login
- Authenticate with Cloudflare One Client は無効

MFA の `0m` は毎回の Access ログインに作用し、既存の Access application session には作用しません。Session Duration の Immediate timeout も同時に設定しないと、2回目の承認で物理キーが省略される可能性があります。

Cloudflare One Client session は application と policy の Session Duration より優先されます。この application では One Client 認証を有効にしてはいけません。

保護対象は `/approval/authorize/*` の GET だけです。この1リクエストで2分間有効な署名済み決定トークンを発行します。`/approval/decision/*` の POST は Access の外ですが、Worker が HMAC、期限、run ID、試行回数、リポジトリ ID、Deployment ID、GitHub の live な状態を検証します。

`/github/webhook` は Access の対象外です。GitHub の `X-Hub-Signature-256` を Worker が検証します。Worker 全体を Access application に指定すると GitHub Webhook まで遮断するため、必ず hostname と path で範囲を限定します。

Zero Trust の Resources、Lists で MFA AAGUIDs のリストを作り、利用する物理キーのモデルだけを追加します。Access settings の Limit MFA to specific authentication methods にこのリストを設定します。AAGUID 制限は新規登録時だけ適用されるため、許可リスト外の登録済み authenticator は管理者が削除します。

Access の App Launcher から物理セキュリティキーを2本登録します。

- 1本は承認時に使用
- 1本はオフラインで保管
- Biometrics、TOTP、IdP の MFA 結果をこの application の代替にしない

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

承認用 Worker のトップページを開き、対象 run を選びます。Cloudflare Access の物理セキュリティキー認証後に、リポジトリ、Workflow、ref、Workflow SHA、Environment、ソース SHA を確認して承認します。

## 本番利用前に必ず試験する

- main ref から Workflow を実行して deploy job が開始しないこと
- production 以外を github-pages Environment が拒否すること
- `EXPECTED_WORKFLOW_SHA` と異なる run を Worker が拒否すること
- 別の Workflow パス、Environment、リポジトリ ID を Worker が拒否すること
- Webhook secret が異なる要求を Worker が拒否すること
- 決定トークンが2分後に失効すること
- 同じブラウザで2回続けて承認し、どちらでも物理キーを要求されること
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
