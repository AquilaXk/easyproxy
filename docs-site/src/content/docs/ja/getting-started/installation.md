---
title: インストール
description: easyproxy(epx)プロキシと前提条件をインストールし、正常に実行できるか確認します。
---

easyproxy をインストールすると同じ実行ファイルを指す `epx` と `easyproxy` コマンドが一緒に提供されます。
どちらも Bun ベースの小さなローカル HTTP サーバーを実行します。モデルリクエストはルーティングで選ばれたプロバイダーに
転送され、必要に応じて vision とウェブ検索のサイドカーが ChatGPT ログインを使うこともあります。

## 前提条件

| 要件 | 理由 |
 --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | `epx` は Bun ランタイムで実行されますが、ランタイムは `npm install` 時に自動でバンドルされるため、Bun を自分でインストールする必要は**ありません**。 |
| **[OpenAI Codex](https://openai.com/codex)**(CLI、App、または SDK) | easyproxy が前に立つクライアントです。easyproxy は `$CODEX_HOME/config.toml`(デフォルト `~/.codex/config.toml`)に書き込みます。 |
| プロバイダーアカウントまたは API キー | Anthropic、xAI、Kimi、Ollama Cloud、OpenRouter、OpenAI API キー、OpenAI 互換エンドポイント、または ChatGPT ログイン。 |

## インストール

```bash
npm install -g --allow-scripts=bun easyproxy
```

:::note[npm が bun の postinstall をブロックした?]
最新の npm は bun の postinstall スクリプトをブロックすることがあります(`npm warn
install-scripts ... blocked because they are not covered by allowScripts`)。
この場合バンドル Bun ランタイムが準備されないため、bun スクリプトを許可して
再インストールしてください。npm 警告の省略コマンドにはパッケージ名が含まれておらず、現在の
ディレクトリを再インストールしてしまうので、必ずパッケージ名を明示してください:

```bash
npm install -g --allow-scripts=bun easyproxy

# 最初に sudo でインストールした場合は sudo を維持してください:
sudo npm install -g --allow-scripts=bun easyproxy
```
:::

両方のコマンドが `PATH` にあることを確認します:

```bash
epx --version
easyproxy --version
```

## スタンドアロンバイナリ（npm 不要）

リリースには、対応する macOS、Linux、Windows 向けのスタンドアロン `epx` バイナリも含まれます。
Bun ランタイムとダッシュボードが含まれるため、npm、Node、別途の Bun インストールは必要ありません。
お使いの環境向けのアーカイブをダウンロードして展開し、次のように実行します。

```bash
./epx --version
./epx start
```

ダッシュボードを提供するため、展開した `gui/dist` ディレクトリはバイナリの隣に置いたままにしてください。

### 配布チャネル

安定チャネルの `latest` にも ChatGPT、OpenAI API キー、OpenRouter、実験段階の Cursor 経路のための
GPT-5.6 Sol/Terra/Luna カタログ情報がすでに含まれています。ただしモデルの利用権まで付与されるわけでは
ありません。まだ正式配布されていない easyproxy ビルドを試す場合のみ preview チャネルを使ってください:

```bash
npm install -g --allow-scripts=bun easyproxy@preview
epx update --tag preview
```

## ソースから実行

easyproxy 自体を直接修正しながら作業するには:

```bash
git clone https://github.com/AquilaXk/easyproxy.git
cd easyproxy
bun install
bun run dev:proxy   # 開発モードでプロキシ API を起動 (src/cli/index.ts start)
bun run dev:gui     # ダッシュボード dev サーバーを起動 (別ターミナル)
```

`bun run dev` は `bun run dev:proxy` のエイリアスとして残っています。プロキシ API は `/healthz`、
`/v1/responses`、`/api/*` を公開し、`GET /` は `bun run build:gui` が `gui/dist` を生成した
後にのみパッケージされたダッシュボードを提供します。ダッシュボードを編集する際は `bun run dev:gui` でフロントエンドを
別途実行してください。

## 生成されるもの

easyproxy の状態ファイルは `$EASYPROXY_HOME`(デフォルト `~/.easyproxy`)の下に、Codex 連携ファイルは
`$CODEX_HOME`(デフォルト `~/.codex`)の下に保存されます。

| パス | 用途 |
 --- | --- |
| `$EASYPROXY_HOME/config.json` | プロバイダー、デフォルトプロバイダー、ポート、オプション。 |
| `$EASYPROXY_HOME/epx.pid` | 実行中のプロキシの PID(単一インスタンスガード)。 |
| `$EASYPROXY_HOME/runtime-port.json` | 現在の PID、ホスト名、ポート。`config.port` が `0` の場合に OS が割り当てたポートも含みます。 |
| `$EASYPROXY_HOME/auth.json` | 保存された OAuth 認証情報(`epx login` 時)。 |
| `$EASYPROXY_HOME/catalog-backup*.json` | easyproxy が変更する前に作成した Codex モデルカタログのバックアップ。 |
| `$CODEX_HOME/config.toml` | ローカル専用構成では easyproxy が管理するルート `openai_base_url` を追加します。ローカル以外のアドレスにバインドする場合は Codex が API 認証ヘッダーを送れるよう `model_provider = "easyproxy"` と `[model_providers.easyproxy]` を使います。 |
| `$CODEX_HOME/easyproxy.config.toml` | デフォルト Codex 設定と一緒に生成される参考用 fallback プロファイル。 |
| `$CODEX_HOME/easyproxy-catalog.json` | Codex が使うネイティブおよびルーティングモデルカタログ。 |

:::note
easyproxy は決して Codex 設定を削除しません。すべての注入は元に戻せます — `epx stop`、`epx restore`、
または `epx eject` は easyproxy が追加した行だけを正確に削除し、ネイティブ Codex を復元します。
:::

## 次へ

[クイックスタート](/ja/getting-started/quickstart/)に進んで最初のプロバイダーを設定するか、
アーキテクチャを知るには[仕組み](/ja/getting-started/how-it-works/)をお読みください。
