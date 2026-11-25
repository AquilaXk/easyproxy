<p align="center">
  <img src="../assets/banner.png" alt="easyproxy — Codex、Claude Code、Claude Desktop、Grok Build などのための一つのローカルゲートウェイ" width="100%">
</p>

<h3 align="center">AI コーディングツールとモデルをつなぐ、一つのローカルゲートウェイ。</h3>
<p align="center"><b>Codex、Claude Code、Claude Desktop、Grok Build で好きなモデルを使い、<br>管理対象の設定で OpenCode、Pi、Qoder、WorkBuddy、Kilo、Cline、T3 Code などを接続できます。</b><br>
<a href="https://easyproxy.me/ja/reference/client-support/">対応ツールをすべて見る →</a></p>

<p align="center">
  <a href="https://www.npmjs.com/package/easyproxy"><img src="https://img.shields.io/npm/v/easyproxy?color=cb3837&label=npm&logo=npm" alt="npm version"></a>
  <a href="https://github.com/AquilaXk/easyproxy/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/easyproxy?color=blue" alt="license"></a>
  <img src="https://img.shields.io/node/v/easyproxy?logo=node.js&label=node" alt="node version">
</p>

```bash
npm install -g --allow-scripts=bun easyproxy
epx start
```

<p align="center">
  <a href="https://github.com/AquilaXk/easyproxy/releases/latest"><img src="https://img.shields.io/badge/macOS-.dmg-24292f?logo=apple&logoColor=white" alt="macOS 版をダウンロード (.dmg)"></a>
  <a href="https://github.com/AquilaXk/easyproxy/releases/latest"><img src="https://img.shields.io/badge/Windows-.msi-24292f?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0zIDNoOC41djguNUgzem05LjUgMEgyMXY4LjVoLTguNXpNMyAxMi41aDguNVYyMUgzem05LjUgMEgyMVYyMWgtOC41eiIvPjwvc3ZnPg==" alt="Windows 版をダウンロード (.msi)"></a>
  <a href="https://github.com/AquilaXk/easyproxy/releases/latest"><img src="https://img.shields.io/badge/Linux-.AppImage-24292f?logo=linux&logoColor=white" alt="Linux 版をダウンロード (.AppImage)"></a>
  <a href="https://github.com/AquilaXk/easyproxy/releases/latest"><img src="https://img.shields.io/badge/Linux-.deb-24292f?logo=debian&logoColor=white" alt="Linux 版をダウンロード (.deb)"></a>
</p>

<table>
<tr>
<td width="50%" valign="middle">

### Claude Code、どんなモデルでも

ピッカーは Claude Code のままです。その裏で動く頭脳だけが違います。

</td>
<td width="50%">
  <img src="../assets/claude-code-models.gif" alt="easyproxy でルーティングされたモデルを動かす Claude Code — ステータスバーに gpt-5.6-luna-medium がアクティブモデルとして表示される" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Codex、どんなモデルでも

プロバイダーを選ぶだけです — 同じワークフロー、違う頭脳。

</td>
<td width="50%">
  <img src="../assets/demo.gif" alt="easyproxy のデモ — Codex アプリで OpenAI 以外のルーティングモデルを使ってタスクを実行" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Claude Desktop、どんなモデルでも

Opus が答えてから、タスクを GPT-5.6 Sol のサブエージェントに渡します。

</td>
<td width="50%">
  <img src="../assets/claude-desktop-subagent.gif" alt="Claude Desktop が Claude Opus 4.8 として応答し、easyproxy 経由で GPT-5.6 Sol のサブエージェントを起動する" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Grok Build、どんなモデルでも

Sol がセッションを進め、Kimi K3 のサブエージェントを呼び出します。

</td>
<td width="50%">
  <img src="../assets/grok-build-subagent.gif" alt="Grok Build が easyproxy 経由で GPT-5.6 Sol を動かし、Kimi K3 のサブエージェントを呼び出す" width="100%">
</td>
</tr>
</table>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.fr.md">Français</a> · <a href="README.ko.md">한국어</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ru.md">Русский</a> · <b>日本語</b> · <a href="README.tr.md">Türkçe</a> · 📖 <a href="https://easyproxy.me/ja/"><b>完全なドキュメント →</b></a>
</p>

easyproxy は、コーディングツールとモデルプロバイダーをつなぐ軽量なローカルゲートウェイです。Responses、Chat Completions、Anthropic Messages API のリクエストを受け取り、プロバイダーのプロトコルに変換します。クライアント、モデル、プロバイダーが対応する場合は、ストリーミング、ツール呼び出し、推論、画像を中継します。Claude、Gemini、Grok、GLM、DeepSeek、Kimi、Qwen、Ollama などのプロバイダーを、Codex、Claude Code、Claude Desktop、Grok Build や[クライアント対応ページ](https://easyproxy.me/ja/reference/client-support/)に記載のツールで使えます。

## クイックスタート

### 個人向けインストール（CLI）

```bash
npm install -g --allow-scripts=bun easyproxy   # Node 18 以上。Bun ランタイムは自動で同梱されます
epx start                         # プロキシとダッシュボードが localhost:10100 で起動
```

バックグラウンドで動かすなら `epx service` を使ってください。

**http://localhost:10100** を開き、Web ダッシュボードですべて設定します。プロバイダーの追加（40 以上の
組み込み、または任意の OpenAI 互換エンドポイント）、モデルの選択、アカウントの管理はここで行います。
`epx gui` でいつでもダッシュボードを開き直せます。

### ツールを接続する

いま使っているツールを接続します。

| ツール | 接続方法 |
|---|---|
| Codex | ダッシュボードの **Route** ページで Codex スイッチをオンにし、通常どおり `codex` を実行します。ローカルリスナーでは Codex の組み込みプロバイダーがプロキシを指すようになります。ターミナルからは、ダッシュボードでプロバイダーを追加する前に `epx init` を実行し、Codex の確認に同意します。 |
| Claude Code | `claude` CLI をインストールした状態で `epx claude` を実行します。必要に応じてプロキシを起動し、そこを経由して Claude Code を起動します。 |
| Claude Desktop | `epx claude desktop` を実行します。新規インストールではアプリ全体にゲートウェイプロファイルを設定します。既存の first-party 設定は維持され、`epx claude desktop apply --gateway` で明示的に切り替えられます。[Claude Code ガイド](https://easyproxy.me/ja/guides/claude-code/)を参照してください。 切り替えた後は Claude Desktop を完全に終了してから開き直してください。 |
| Grok Build | ローカルリスナーで Grok 連携が有効かつ `~/.grok` が存在する場合、`epx start` がモデルを登録します。Grok Build で `epx-*` モデルを選択してください。リモート設定は [Grok Build ガイド](https://easyproxy.me/ja/guides/grok-build/)を参照してください。プロバイダーを追加した後は、プロキシを再起動する（または Codex 自動起動が有効なら `epx ensure` を実行する）と一覧を更新できます。 |
| 管理対象の統合があるツール | ダッシュボードの **Route** ページか `epx integration client enable --client <id>` を使います。 |
| その他のツール | カスタムの OpenAI 互換ベース URL に `http://localhost:10100/v1` を、または Anthropic ベース URL に `http://localhost:10100` を設定します。 |

各ツールの接続方法と対応プロトコルは[クライアント対応ページ](https://easyproxy.me/ja/reference/client-support/)に記載しています。

<details>
<summary><b>デスクトップアプリ（ベータ版）</b></summary>

デスクトップアプリは、同じプロキシとダッシュボードをネイティブウィンドウに収め、トレイと同梱の `epx` を備えたものです。
すでに起動しているプロキシに接続するか、同梱のプロキシを起動します。ダッシュボードはプロキシの
ポートで開きます（別のポートを設定していなければ **http://localhost:10100**）。
[最新リリース](https://github.com/AquilaXk/easyproxy/releases/latest)から、お使いのプラットフォーム向けのファイルを選んでください。

| プラットフォーム | ファイル | 備考 |
|---|---|---|
| macOS 14 以降（Apple Silicon と Intel） | `EasyProxy-<version>-macos.dmg` | ユニバーサルビルド。Apple Developer ID 署名と公証が設定されるまで未署名配布（macOS Gatekeeper では **右クリック → 開く** が必要な場合があります） |
| Windows（x64） | `EasyProxy-<version>-windows-x64.msi` | SignPath Foundation によるコード署名を導入中（[コード署名ポリシー](https://easyproxy.me/ja/reference/code-signing/)）。署名前のリリースでは SmartScreen が一度だけ確認するので、**詳細情報 → 実行**を選択 |
| Linux（x86_64） | `EasyProxy-<version>-linux-x86_64.AppImage` または `-linux-amd64.deb` | トレイには AppIndicator 対応のデスクトップが必要 |

リリースページでは各ファイルの横に `.sha256` があります。macOS 14 以降では、プロキシの状態、
今日の使用量、プロバイダーのクォータを表示する WidgetKit 拡張も付属します。表示に使う
スナップショットモデルは [`app/`](../app)（`MenuBarCore`）にあります。アプリを自分でビルドするには、
リポジトリのルートで `bun install && bun run build:gui` を実行し、
`desktop/` で macOS なら `bun install && bun run prepare-sidecar && bun run prepare-widget && bun run build:local`、Windows と Linux なら `bun install && bun run prepare-sidecar && bun run build:local` を実行します（ウィジェットの手順は macOS 専用です）。
[デスクトップアプリガイド](https://easyproxy.me/ja/guides/desktop-app/)と
[macOS メニューバーアプリガイド](https://easyproxy.me/ja/guides/macos-menu-bar/)で初回起動について説明しています。
[`CLI_CONSENT.md`](../CLI_CONSENT.md#where-things-are-installed) にはディスクに書き込まれるすべてのものをまとめています。

</details>

<details>
<summary>Docker Compose</summary>

このリポジトリには、digest 固定で非 root の Compose ビルドが入っています。ビルドは、選択した Git
スナップショットから正式な互換性マニフェストを生成して検証します。ローカルクローンには Git と Docker
Compose、リモート Git コンテキストには Docker Compose が必要です。どちらの方法でも、ホスト上の Bun や
準備手順は不要です。データプレーンのトークンを stdin から一度だけ初期化してハブを起動します:

```bash
git clone https://github.com/AquilaXk/easyproxy.git
cd easyproxy
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
curl --fail --silent http://127.0.0.1:10100/healthz
curl --fail --silent http://127.0.0.1:10100/readyz
```

既定のホストバインドは `127.0.0.1:10100` です。リモートへ公開するには
`EASYPROXY_BIND_ADDRESS=<LAN-or-Tailscale-IP> docker compose up -d` を明示する必要があり、
`0.0.0.0` はホストのすべてのインターフェースを開きます。ファイアウォールと、認証付きの TLS または
tailnet のフロントエンドでアクセスを制限してください。生成された JSON は追跡されません。ビルド
コンテキストが受け入れるのは `.git/index` と `.git/HEAD`、つまり `git ls-files` が読み取るインベントリ
だけです。オブジェクトストア全体ではなく約 1 MB であり、読み取り専用マウントを通じてビルド専用の
マニフェストステージからのみ参照できるため、`.git` を含む `COPY` はありません。ホストで生成済みの
マニフェストは検証後にのみ受け入れられ、それ以外の場合はビルドが自動生成します。ビルドは古い
マニフェスト、欠けているファイルや不一致のファイル、余分なソースファイル、シンボリックリンクを
拒否します。記録された SHA-256 は、ビルドコンテキストとコピーされたランタイム
ファイル（`package.json`、`bun.lock`、明示的に含めた `scripts/model-metadata.source.json`）の
すべてと照合されます。

リモート Git コンテキストでは、BuildKit が Git メタデータを保持する必要があります。次の Compose
ビルド断片はリモートスナップショットを選択し、必要な組み込み引数を渡します:

```yaml
services:
  hub:
    pull_policy: build
    build:
      context: https://github.com/AquilaXk/easyproxy.git#main
      dockerfile: Dockerfile
      target: runtime
      args:
        BUILDKIT_CONTEXT_KEEP_GIT_DIR: "1"
```

トークンと可変状態は `epx-state` という named volume に残り、イメージ、Compose ファイル、環境変数、
シェル引数のどこにも認証情報は置かれません。プロバイダーの設定、認証付きの受け入れ確認、リモート管理、
ロールバックは [Remote Hub デプロイガイド](https://easyproxy.me/ja/guides/remote-hub/)
を参照してください。

</details>

<details>
<summary>ソースからインストール（最新の main）</summary>

**macOS / Linux:**

```bash
curl -fsSL https://bun.sh/install | bash
git clone -b main https://github.com/AquilaXk/easyproxy.git
cd easyproxy && ~/.bun/bin/bun install
~/.bun/bin/bun run build:gui
~/.bun/bin/bun run src/cli/index.ts start
```

**Windows (PowerShell):**

```powershell
irm bun.sh/install.ps1 | iex
git clone -b main https://github.com/AquilaXk/easyproxy.git
cd easyproxy; bun install
bun run build:gui
bun run src/cli/index.ts start
```

ソースからのインストールは最新の `main` ブランチを動かします。メモリ所有権のパッチ、ランタイムの GC
改善、まだリリースされていない修正は、npm パッケージより先にここへ入ります。

</details>

<details>
<summary>エージェント向け</summary>

```bash
npm install -g --allow-scripts=bun easyproxy
epx start     # または `epx service`
epx init      # 対話式セットアップ: ~/.easyproxy/config.json を書き、Codex を接続します
```

`epx init` はプロキシを起動しません。先に起動してください（後でもかまいません。順番は問いませんが、
`epx provider add` や `epx combo set` のようなヘッドレスコマンドは**動作中の**プロキシと通信し、
届かなければ非ゼロで終了します）。`epx status` / `epx doctor` / `epx health` が動作状態を報告します。

> **easyproxy をインストールまたは実行するエージェントへ:**
> [`CLI_CONSENT.md`](../CLI_CONSENT.md) を読んでください。対話的な `epx start` は、このリポジトリ
> に star を付けるかどうかを一度だけ尋ねることがあります。それはユーザーの判断であり、エージェントの
> 判断ではありません。CLI はエージェント実行ではこのプロンプトを抑制し、API は
> `403 agent_consent_required` で拒否します。

</details>

## 対応プラットフォーム

| OS | 状態 | サービスマネージャー | デスクトップアプリ（ベータ版） |
|---|---|---|---|
| macOS (arm64 / x64) | 完全対応 | launchd | ユニバーサル `.dmg` |
| Linux (x64 / arm64) | 完全対応 | systemd (user unit) | x86_64 `.AppImage` / `.deb` |
| Windows (x64) | 完全対応 | タスクスケジューラ（非表示）/ 任意のネイティブサービス（`--native`、WinSW） | x64 `.msi` |

CLI インストールには [Node](https://nodejs.org) 18 以上が必要です。デスクトップアプリには Node も Bun も不要です。Bun ランタイムは `npm install` で同梱されるので、Bun を
別途入れる必要も、Windows で WSL を使う必要もありません。npm が同梱ランタイムのインストールスクリプト
をブロックした場合は[インストールドキュメント](https://easyproxy.me/ja/getting-started/installation/)を
参照してください。

## 主な特徴

- **Codex、Claude Code、Claude Desktop、Grok Build でどの LLM でも** — 40 以上のプロバイダーが最初から
  使え、それぞれがネイティブの UI を保ちます。
- **コンボ** — 1 つの仮想モデル ID で、複数プロバイダーにまたがる failover や重み付きラウンドロビンを
  組みます。[コンボガイド](https://easyproxy.me/ja/guides/combos/)を参照してください。
- **どのモデルでもサブエージェントに** — ルーティングしたモデルを Codex のサブエージェントピッカーに
  出し、v1/v2 の表面制御とフォールバックチェーンを設定できます。
  [サブエージェントガイド](https://easyproxy.me/ja/guides/sub-agent-surface/)を参照してください。
- **一度ログインすれば API キーは不要** — xAI、Anthropic、Kimi は OAuth に対応します。あるいは
  `codex login` を転送する、キーを貼り付ける、`${ENV_VAR}` 参照を使う、のいずれでもかまいません。
- **Web 検索とビジョンのサイドカー** — OpenAI 以外のモデルも、ChatGPT ログインの上で動くサイドカーを
  通じて本物の Web 検索と画像理解を使えます。
- **何が起きているか見える** — ダッシュボードがプロバイダー、OAuth の状態、モデルの選択、そしてキャッシュ
  トークン数まで含むリアルタイムのリクエストログを表示します。
- **後始末の要らない終了** — `epx stop` が Codex を元の設定に戻します。
- **上限のあるメモリ所有権** — 長く生きるキャッシュ、リングバッファ、プロトコル変換のストアには、必ず
  有限の上限、バイト予算、あるいは能動的な reconciliation があります。config を再読み込みしたあとに
  上限のない `Map` や `Set` は残りません。

<details>
<summary>メモリ所有権の詳細</summary>

EasyProxy はプロセスが保持する状態を以下のカテゴリで追跡し、それぞれに文書化された上限があります:

- **保持ストア 15 個**（リクエストログ、デバッグリング、画像キャッシュ、モデルキャッシュ、ビジョンの
  説明、カーソル blob、responses の継続など）はバイト単位で集計され、アプリが持つメモリ予算
  （既定 256 MiB）によって退避されます。ただしネイティブ制御のリプレイ用ストアは固定され、
  退避されません。
- **観測バッファ 4 個**（トランスレーターのアキュムレーター、画像・OAuth・Grok の tail）は処理中の
  バイト圧力を監視するだけで、退避はしません。
- **state-store の登録 32 個**が期限切れの掃除（60 秒間隔）と config 世代の reconciliation を担い、
  古いプロバイダー／アカウントのキーを取り除きます。
- **パスとフィンガープリントのメモ**（ワークスペースのメタデータ、hardened identity、インストール
  salt、mode-hint の capability）は挿入順の LRU 上限（8〜128 件）を使います。
- **モデルキャッシュの世代 tombstone** は reconciliation のあとに削除されます。グローバルな世代を
  進めることで、進行中だった古い discovery が削除済みのプロバイダーを復活させないようにしています。
- **Lab のイベント ID 重複排除**はディスク上の ledger ロックの下で動き、プロセス側の RAM インデックス
  は持ちません。

管理トークンを付けて `GET /api/system/memory` を叩けば、現在の保持バイト数、退避カウンター、
ウォッチドッグのサンプルを確認できます。

</details>

## モデルルーティング

`provider/model` の書き方で、設定済みのどのプロバイダーとモデルでも指定できます:

```bash
codex -m "anthropic/claude-opus-5" "このスタックトレースを説明して"
codex -m "google/gemini-3-pro" "auth.ts のユニットテストを書いて"
codex -m "ollama/llama3" "この関数をリファクタリングして"
```

`provider/` の接頭辞を省くと、既定のプロバイダーを使うか、モデル名のパターンで自動的に一致させます。
`/` を含むプロバイダーのモデル ID は、内側のスラッシュを `-` に置き換えた別名で公開され、スラッシュ
のままの完全形も引き続き使えます。詳細は
[モデルルーティングのドキュメント](https://easyproxy.me/ja/guides/model-routing/)を参照してください。

### JEV Auto ルーティング（任意）

TypeSafe JEV は、明示的に有効にした Combo の最初のモデルと推論エフォートを選べます。通常のモデル
ピッカーと直接ルートは変わりません。認証情報は `epx login jev`、**Providers → TypeSafe JEV → Add API key**、
または `TYPESAFE_API_KEY`/`JEV_API_KEY` で追加します。次に **Models → Combos → Create JEV Auto** を開き、
許可するターゲットモデルを選んで、ターゲットごとに JEV が選べるエフォートをチェックします。
エフォート設定に触れていないターゲットは、そのモデルが現在公開しているすべてのエフォートを許可します。

JEV は `jev-auto` でのみ、論理的なモデル呼び出しごとに一度だけ使われます。認証情報がない場合、
ネットワーク障害、または不正な判定のときは、現在利用可能な最初のターゲットへフェイルオープンします。
呼び出し元のキャンセルは引き続きリクエストをキャンセルします。自動テストは TypeSafe のモック
エンドポイントを使い、実際の JEV アカウントは検証しません。

JEV Combo は、キー不要の Ollama `tev1` のようなセルフホストの判断モデルを代わりに使うこともできます。
`baseUrl` が完全な `/v1/systemone` エンドポイントである `jev-decision` プロバイダーを追加し、Combo の
`decisionProvider` に指定します。TypeSafe の認証情報がそこへ送られることはありません。詳しくは
[セルフホストの判断モデル](https://easyproxy.me/ja/guides/combos/)を参照してください。

## プロバイダーとアダプター

OpenAI（ChatGPT ログインまたは API キー）、Anthropic、Google Gemini、xAI、Kimi、Azure OpenAI、Ollama
（ローカル + Cloud）、Cursor（実験的）、そしてあらゆる OpenAI 互換エンドポイント。さらに DeepSeek、
Groq、OpenRouter、OpenGateway、Together、Fireworks、Cerebras、Mistral、Hugging Face、NVIDIA NIM、MiniMax、
Qwen Cloud、Qoder Global と CN（公式 PAT + CLI）、SiliconFlow などがあります。全一覧は `epx init` か
[プロバイダーのドキュメント](https://easyproxy.me/ja/guides/providers/)で確認できます。

## CLI

```bash
epx init                       # 対話式セットアップ（config を書き、Codex を接続し、shim を提案）
epx start [--port 10100] [--socks5 [host:port] | --socks5-off]  # SOCKS5 の既定値は socks5://127.0.0.1:10808
epx stop                       # 停止してネイティブの Codex を復元
epx service [install|repair|restart|start|stop|status|uninstall|remove]  # バックグラウンドサービス
epx codex-shim install         # `codex` の起動時にプロキシをオンデマンドで立ち上げる
epx health [--json]            # プロキシが今生きているかを確認
epx ready [--json] [--wait [--timeout <seconds>]]  # 同期後の準備状態を確認
epx status                     # プロキシは動いているか
epx gui                        # Web ダッシュボードを開く
epx provider <...>             # プロバイダーの管理（list/add/edit/test/remove）
epx account <...>              # ChatGPT アカウントと API キープールの管理
epx combo <...>                # failover / ラウンドロビンのコンボ管理
epx v2 <...>                   # マルチエージェント v1/v2 の表面制御
epx update [--tag preview]     # easyproxy の更新
```

希望するポートが使用中の場合、起動は別のポートへ移らずに停止し、そのポートを保持しているプロセスを示します。
そのため、既存のプロキシと並んで 2 つ目のプロキシが動き続けることはありません。ポートを空けるか、`--port` で
別のポートを指定してください。全リファレンスは
[CLI のドキュメント](https://easyproxy.me/ja/reference/cli/)にあります。

### ヘルスと準備状態

`GET /healthz` はプロキシが今生きているかをすぐに返します。認証の要らない `GET /readyz` は、同期が
終わったあとの準備状態を、機微な情報を除いた JSON identity `{service, version, uptime, pid, port, status}`
で返します。`status` が `ready` なら `200`、`pending` と最終的な `failed` は `Retry-After: 1` を
付けて `503` を返します。

`epx ready [--json] [--wait [--timeout <seconds>]]` は既定で 1 回だけ probe します。`--wait` は既定で
最大 45 秒ポーリングしますが、最終的な `failed` を見た時点ですぐ終了します。`--timeout <seconds>` は
1〜300 秒の上限を設定し、`--wait` を必要とし、正の整数だけを受け付けます。CLI の `--json` 出力は
`{ready, status, pid, port}` で、`status` は `ready`、`pending`、`failed`、`unreachable` のいずれかです。

| 終了コード | 結果 |
| --- | --- |
| `0` | 準備完了 |
| `1` | 準備できていない: pending、failed、タイムアウト、到達不能 |
| `64` | 引数が不正 |

`/readyz` を持たない古いプロキシは `unreachable` として fail-closed になり終了コード 1 を返します。
`epx health` はそのまま互換です。

### 自動起動: service と shim

常時稼働でクラッシュ時に再起動させたいなら **service**（`epx service`）を使います。バックグラウンド
デーモンなしで軽くオンデマンドに起動したいなら **shim**（`epx codex-shim install`）を使います。削除は
`epx service uninstall` / `epx codex-shim uninstall` です。

### アンインストール

```bash
epx uninstall                  # 停止し、service/shim を削除し、ネイティブ Codex を復元し、状態を片づける
npm uninstall -g easyproxy
```

## リモートアクセス

easyproxy は既定で `127.0.0.1` にバインドし、追加の認証を必要としません。ループバックの外へ
バインドする場合（`"hostname": "0.0.0.0"`）は bearer トークンが**必須**です。
`EASYPROXY_API_AUTH_TOKEN` がなければプロキシは起動を拒否し、すべてのクライアントリクエストは
`x-easyproxy-api-key` としてトークンを乗せる必要があります。詳細は
[設定リファレンス](https://easyproxy.me/ja/reference/configuration/)にあります。

## 高度な使い方

上級ユーザー向けのセルフホスト型オプションです。有効にする前に各プロバイダーの規約を確認してください。

### ChatGPT アカウントプール

easyproxy では、Codex 認証用の **ChatGPT アカウントプール**も管理できます。ChatGPT / Codex のアカウントを
複数追加し、5 時間 / 週間 / 30 日のクォータをダッシュボードで更新します。クォータルーティングでは、新しい
セッションが使用量の最も少ない健全なアカウントを使えます。ラウンドロビンと fill-first はそれぞれの方針に
従います。既存の Codex スレッドは通常、開始したアカウントとの affinity を保つので、長い SSH・tmux・
モバイル接続のセッションが会話の途中でアカウントを乗り換えることはありません。ただしクォータの再評価、
failover、アカウントの除外、affinity の失効、401/403 や 429 からの復帰では再バインドされることがあります。
ふだんは使わず他が尽きたときだけ回したいアカウント（多くは Codex Desktop のログイン）があるなら、
アカウントに選択順を指定してください。

- **ChatGPT アカウントのプール** — スレッド affinity、クォータを見た自動切り替え、クールダウン、
  fail-closed な認証処理。

  > **プロバイダーポリシーに関する注意:** アカウントプールはルーティングと運用の耐障害性のためのもので
  > あり、プロバイダーのレート制限、措置、停止その他のアカウント処分から守るものではありません。
  > EasyProxy は、プロバイダーの制限を回避するために追加のアカウントを使うことや、アカウントの認証情報
  > を人と共有することを推奨しません。各プロバイダーの現行の規約を守る責任は利用者にあります。
  > [Codex Auth とアカウントプールの案内](https://easyproxy.me/ja/guides/web-dashboard/)
  > と [OpenAI の現行利用規約](https://openai.com/policies/terms-of-use/)をご覧ください。

## ドキュメント

公開ドキュメント（インストール、プロバイダー、ルーティング、コンボ、サブエージェント、サイドカー、
連携、CLI／設定／管理 API のリファレンス）は [`docs-site/`](../docs-site) からビルドされ、
**[easyproxy.me](https://easyproxy.me/ja/)** に公開されています。

メンテナー向けの source-of-truth なノートは [`structure/`](../structure) に、コントリビューターの
[`SECURITY.md`](../SECURITY.md) にあります。未公開の脆弱性は公開 issue ではなく
[GitHub の非公開脆弱性報告](https://github.com/AquilaXk/easyproxy/security/advisories/new)から
非公開で報告してください。
技術的な窓口はこのフォームだけで、セキュリティ用のメールアドレスはありません。やり取りは非公開の報告の
中で続けてください。公開 issue に置いてよいのは調整のための連絡だけで、脆弱性の詳細は置けません。受領の
連絡はトリアージではなく、初回応答までの期限も約束していません。

## 開発

ソース開発には `PATH` に `bun` CLI が必要です。公開 npm パッケージはインストール済みの `epx`
コマンド用に Bun ランタイムを同梱し、パッケージのスクリプトもこの同梱依存関係から Bun を解決することがあります。

```bash
git clone https://github.com/AquilaXk/easyproxy.git
cd easyproxy
bun install
bun run typecheck
bun run test
```

## コード署名ポリシー (Code signing policy)

Windows 向けバイナリは Authenticode 署名へ移行中です。移行状況、署名の確認方法、ポリシー全文は [Windows コード署名ガイド](https://easyproxy.me/ja/reference/code-signing/) を参照してください。

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

- Committers and reviewers: [AquilaXk](https://github.com/AquilaXk)
- Approvers: [AquilaXk](https://github.com/AquilaXk)
- Privacy: easyproxy sends one anonymous daily usage summary (a per-day install hash that changes daily, version, release channel, platform, install channel, provider kind, coarse model family, active minutes and request, token and error counts; never prompts, model outputs, keys, accounts, hostnames or paths) to telemetry.easyproxy.me, and only after the person installing or operating it has seen the notice in the dashboard or an interactive CLI prompt and has not declined. It can be turned off in that notice, in the Windows installer ("Send anonymous usage statistics", checked by default), in Proxy details, or with epx telemetry disable, EPX_TELEMETRY=0 or DO_NOT_TRACK=1. Only project-wide aggregates of this anonymous data are public. A separate public leaderboard profile is off unless you connect one yourself (dashboard Home or epx telemetry profile connect); it shares only a chosen handle, display name and colour and your daily request, token and model-family totals, never your anonymous telemetry ID, and disconnecting deletes it. Everything else goes only to the providers and services you configure. See the [telemetry guide](https://easyproxy.me/ja/guides/telemetry/).

## 免責事項

easyproxy はコミュニティが維持する独立したプロジェクトであり、**OpenAI、Anthropic をはじめとするどの
プロバイダーとも提携しておらず、承認も受けていません。**

一部のプロバイダー、とくに Anthropic (Claude) は、サードパーティのプロキシ経由で API トラフィックを流すアカウントを停止または制限することがあります。**自己責任でご利用ください (UAYOR)。** プロバイダーを接続する前に、その利用規約でプロキシ経由のアクセスが認められているか確認してください。easyproxy のメンテナーは、アップストリームのプロバイダーが取ったアカウント処分について責任を負いません。

## ライセンス

MIT
