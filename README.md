# GitHub Pages 物理キー承認プロトタイプ

main を通常開発用、production を固定デプロイ用として分離し、GitHub Pages の公開直前に物理セキュリティキーを要求するプロトタイプです。

この構成は通常の Write 権限が侵害されても、Approval GitHub App と Cloudflare Access を通らずに GitHub Pages を更新できないことを目的にします。リポジトリの Admin、Organization Owner、Cloudflare 管理者、DNS 管理者の侵害は防げません。

構成要素は次のとおりです。

- `site` は GitHub Pages に公開する Vite サイト
- `approval` は承認要求を表示する Vite UI
- `worker` は GitHub Webhook、Access JWT、GitHub App API を扱う Cloudflare Worker
- `.github/workflows/deploy-pages.yml` は production ref からだけ実行する固定 Workflow
- `wrangler.jsonc` は Worker の非機密設定と binding

GitHub の仕様により `workflow_dispatch` の定義ファイルは既定ブランチにも必要です。そのため Workflow ファイルは main にも存在します。実際のデプロイでは production ref のファイルだけを実行し、github-pages Environment の deployment branch rule でも production 以外を拒否します。

Worker は次を Webhook 受信時と決定直前に検証します。

- リポジトリ ID と名前
- Workflow のパス
- production ref
- production の固定コミット SHA
- github-pages Environment
- workflow_dispatch イベント
- Workflow run ID と試行回数
- GitHub の callback URL
- main から公開するソース SHA の形式

KV は承認要求の一覧に使います。承認の根拠には使わず、GitHub API から現在の Workflow run を再取得します。

セットアップには GitHub と Cloudflare の手作業が必要です。[必須セットアップ](docs/required-setup.md)を上から順に実行してください。Custom deployment protection rule は 2026年8月4日時点で Public Preview です。

ローカルで静的確認するには Node.js 24 と pnpm 10 を使います。

```shell
pnpm install --frozen-lockfile
pnpm run check
VITE_SOURCE_SHA=1111111111111111111111111111111111111111 pnpm run build:site
```

実際の Secret はリポジトリへ保存しません。Worker の Secret 名だけを `wrangler.jsonc` に宣言しています。

参考資料:

- [GitHub custom deployment protection rule](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/create-custom-protection-rules)
- [GitHub workflow_dispatch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)
- [Cloudflare Independent MFA](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/)
- [Cloudflare Access session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)
- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
