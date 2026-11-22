---
title: クイックスタート
description: "easyproxy をインストールして最初のプロバイダーを追加し、Codex、Claude Code、Claude Desktop、Grok Build など、普段使う対応コーディングツールを接続します。"
---

このガイドでは、新規インストールから普段使うコーディングツールで最初のリクエストを送るまでを説明します。手順 1 と 2 は全ツール共通で、手順 3 はツール別です。[クライアント対応ページ](/ja/reference/client-support/)に各ツールと接続方法を記載しています。

## スタンドアロンバイナリ（npm 不要）

npm を使わず、Bun ランタイムを含むリリースアーカイブの `epx` バイナリも利用できます。
`gui/dist` ディレクトリをバイナリの隣に置いて展開し、`./epx start` を実行してください。

## 1. セットアップウィザードを実行します

```bash
epx init
```

`epx init` では次の手順を説明します。

1. **プロバイダーを選択してください** — 112 個の組み込みレジストリプリセットのいずれか、または `custom` を選択してベース URL とアダプターを入力します。
2. **API キー** — キーを貼り付けるか、`${ANTHROPIC_API_KEY}` のような環境変数を参照します。
3. **デフォルト モデル** — キー、ローカル、カスタム プロバイダーの場合は、プリセットを受け入れるか、モデル ID を入力します。
4. **プロキシ ポート** — デフォルトは `10100` です。
5. **Codex に挿入しますか?** - 通常のループバック設定では、easyproxy はルート `openai_base_url` を
`$CODEX_HOME/config.toml` (デフォルトは `~/.codex/config.toml`) なので、Codex の組み込み `openai` プロバイダーはプロキシをターゲットにします。リモート/LAN バインドでは、代わりに API 認証ヘッダーを持つ専用プロバイダー エントリを使用します。
6. **自動起動シムをインストールしますか?** — 有効にすると、`codex` を起動すると、最初に `epx ensure` が実行されます。

結果は `$EASYPROXY_HOME/config.json` (デフォルトは `~/.easyproxy/config.json`) に保存されます。

:::note[GPT-5.6 ロールアウト エントリ]
現在の安定版リリースでは、ChatGPT パススルー、OpenAI API キー、OpenRouter、実験用 Cursor アダプター用に GPT-5.6 Sol/Terra/Luna をシードしています。これらは、上流アカウントがアクセス権を持っている場合にのみ機能します。 OpenAI API キーと OpenRouter プリセットは、922,000 トークンの使用可能なコンテキスト ウィンドウをアドバタイズします。カーソルは独自のアダプターのメタデータを保持します。
:::

## 2.プロキシを開始します

次のどちらか一方を実行します。プロキシはフォアグラウンドで動作します。

```bash
epx start            # defaults to port 10100
```

別のポートを使う場合はこちらを実行します。

```bash
epx start --port 8080
```

この端末は開いたままにしてください。続く状態確認とダッシュボードのコマンドは、同じ `EASYPROXY_HOME` を設定した別の端末で実行します。

開始時、easyproxy:

- PID を `~/.easyproxy/epx.pid` に書き込みます (そして 2 回起動を拒否します)。
- プロバイダーがサポートするライブ モデルを検出し、**ネイティブ エントリとルーティングされたエントリを同期します
Codex のモデル カタログ**、
- `http://localhost:<port>/v1`で聴いています。

同じ `EASYPROXY_HOME` を使う easyproxy が動作中なら、空いているポートでも 2 つ目は起動できません。先に所有インスタンスを `epx stop` で停止するか、別の `EASYPROXY_HOME` を選んでください。兄弟インスタンスは専用ポートへの直接要求を処理しますが、Codex、Grok、Claude の共有ルーティングは変更しません。無関係なプロセスがポートを使っている場合、`epx start` が通知します。`epx start --port <port>` で空いているポートを指定してください。自動で別のポートに切り替わることはありません。

確認してください:

```bash
epx status
epx gui       # open the dashboard on the live port
```

## 3. ツールを接続する

使用するツールの手順を選んでください。複数のツールを接続でき、プロバイダーとモデルを共有します。

### Codex

手順 1 で Codex の確認に同意した場合、Codex は透過的に easyproxy と通信します。確認を拒否した場合、または既存の設定があるためにセットアップが終了した場合は、Codex を実行する前にダッシュボードの **Connect** ページにある Codex スイッチをオンにします。[Codex 統合](/ja/guides/codex-integration/)では変更内容と復元方法を説明しています。

```bash
codex "Refactor this function for readability"
```

特定のルーティングされたモデルをターゲットにするには、Codex のモデル ピッカーに表示される `provider/model` フォームを使用します。

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

### Claude Code

`claude` CLI をインストールした状態で実行します。

```bash
epx claude
```

`epx claude` はプロキシが停止中なら起動し、easyproxy を指す環境で Claude Code を起動します。追加の引数はそのまま渡されます。階層のデフォルト、他のランチャー、無効化の方法は [Claude Code](/ja/guides/claude-code/)を参照してください。

### Claude Desktop

```bash
epx claude desktop
```

新規インストールではアプリ全体にゲートウェイプロファイルを設定します。すでに first-party モードを使用している場合はそのまま維持され、`epx claude desktop apply --gateway` を実行すると明示的に切り替えられます。Desktop を claude.ai のままにして Code タブのみをルーティングする first-party モードは、[Claude Code](/ja/guides/claude-code/)の Claude Desktop モードの節を参照してください。

モードを切り替えた後は、Claude Desktop を完全に終了してから開き直してください。

### Grok Build

ローカルリスナーでは、`~/.grok` が存在すると `epx start` が表示対象のモデルを `~/.grok/config.toml` に登録します。Grok Build で `epx-*` モデルを選択します。リモート設定と管理対象ブロックは [Grok Build](/ja/guides/grok-build/)を参照してください。

プロバイダーやモデルを追加した後は、`epx ensure` を実行するかプロキシを再起動すると Grok Build に反映されます。

### その他のツール

管理対象の統合があるツール（OpenCode、Pi、Qoder、WorkBuddy、Kilo、Cline、T3 Code など）は、ダッシュボードの **Connect** ページまたは次のコマンドで接続します。

```bash
epx integration client enable --client <id>
```

各ツールの設定ファイルと変更の反映時期は[統合](/ja/guides/integrations/)を参照してください。カスタムエンドポイントに対応するその他のツールでは、OpenAI 互換ベース URL `http://localhost:10100/v1` または Anthropic ベース URL `http://localhost:10100` を使えます。

## サブエージェント モデルの選択 (オプション)

新しい設定には、Codex のサブエージェント ピッカーの 5 つのネイティブ モデル、`gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、および `gpt-6-astra` が含まれています。 `epx gui` を開いて、最大 5 つのネイティブ モデルまたはルーティング モデルを置換または並べ替えます。ダッシュボードでは、優先サブエージェント モデルと推論負荷を 1 つ設定することもできます。 v1/base/v2 を選択し、ガイダンス、ネイティブのデフォルト、およびフォールバックがいつ適用されるかを理解するには、[サブエージェントサーフェス](/guides/sub-agent-surface/) を参照してください。

## キーを貼り付ける代わりにログインする

一部のプロバイダーはリアル アカウント ログイン (OAuth、自動更新) をサポートしています。

```bash
epx login xai          # or: anthropic, kimi, kiro, google-antigravity, cursor
epx logout xai
```

OpenAI 自体には **キーは必要ありません**。デフォルトのプロバイダーは既存の `codex login` 認証情報をそのまま転送します ([プロバイダー](/guides/providers/) を参照)。

## 停止と復元

```bash
epx stop          # stop the proxy and restore native Codex
epx restore       # restore native Codex without stopping (alias: epx eject)
epx restore back  # route Codex through the still-running proxy again
```

## 次

- [仕組み](/getting-started/how-it-works/) — 各リクエストに何が起こるか。
- [プロバイダー](/guides/providers/) — あらゆる認証方法。
- [構成](/reference/configuration/) — `config.json` の完全なリファレンス。
