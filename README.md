# AI BRIEF Ultra

アクセスするたびに最新のAIニュースを取得し、重複除去・急上昇ランキング・企業別ページ・記事詳細を提供するニュースサイトです。

## 主な機能

- 最新AIニュースの自動取得
- Google News RSSを複数クエリで並列取得（APIキー不要）
- 日本語圏 + グローバルAIニュースを統合
- タイトル正規化による完全重複除去
- 日本語文字n-gram + 英数字トークンによる類似見出しクラスタリング
- 急上昇スコアリング
  - 鮮度
  - 近似記事を報じた媒体数
  - 複数検索トピックで検出された広がり
  - 同一ニュースクラスタの記事量
- OpenAI / Google / Anthropic / NVIDIA / Meta / Microsoft / xAI / Amazon・AWS の企業分類
- 記事詳細ページ `article.html?id=...`
- スコア式の関連記事表示
- 最大180件を対象にした検索 / カテゴリ絞り込み / 並び替え（初期30件、追加表示方式）
- レート制限付き手動「更新」ボタン
- 10分キャッシュ + stale-while-refresh + 障害時指数バックオフ
- 外部取得障害時：ディスクキャッシュ → 内蔵フォールバック
- PWAシェル + サイズ固定の静的ニューススナップショットによるオフライン表示
- RSS URL / 日時 / キャッシュschema / API数値パラメータの検証
- レスポンシブUI
- 広告SDK / 解析SDK / 外部フロントエンドライブラリなし
- Node.js標準機能のみ（npm install不要）
- GitHub ActionsでNode.js 18 / 22を継続検証

## Windowsで最短起動

1. Node.js 18以上をインストールします。
2. `start.bat` をダブルクリックします。
3. `http://127.0.0.1:8787` がブラウザで開きます。

`start.bat` / `start.sh` はNode.jsの存在だけでなくメジャーバージョンも確認します。

## コマンドで起動

```bash
node server.js
```

または

```bash
npm start
```

依存パッケージはありません。`npm install` は不要です。

## 検証

構文チェック：

```bash
npm run check
```

回帰テスト：

```bash
npm test
```

両方まとめて：

```bash
npm run verify
```

CIはNode.js 18 / 22の両方で `npm run verify` を実行します。

API動作確認：

- `GET /api/health`
- `GET /api/news?limit=20`
- `GET /api/news?company=openai`
- `GET /api/news?category=safety`
- `GET /api/news?q=Gemini`
- `GET /api/trending?limit=15`
- `GET /api/article?id=ARTICLE_ID`
- `GET /api/meta`
- `GET /api/snapshot`（PWA用の単一・全件スナップショット）
- `POST /api/refresh`（同一オリジンのみ、送信元ごとの更新間隔制限あり）

不正な `limit` / `offset` / 記事IDは、空データへ化けずHTTP 400を返します。

## 自動取得の仕組み

サーバーは以下を独立した検索フィードとして取得し、統合します。

- AI総合
- 日本語AI
- OpenAI
- Google / DeepMind / Gemini
- Anthropic / Claude
- NVIDIA / AI chip / data center
- AI safety / regulation / security
- AI research / machine learning

Google News RSSは無料・認証不要ですが、提供仕様が将来変わる可能性があります。そのため本サイトは取得失敗時にニュース欄が空にならないよう、ディスクキャッシュと内蔵フォールバックを持ちます。

## キャッシュ / 障害耐性

既定値：

- 通常キャッシュ: 10分
- TTL超過後も保存済みニュースを即時返し、裏で再取得
- 外部取得の連続失敗時は指数バックオフ（最大15分）
- 大規模取得失敗: 最後の正常ディスクキャッシュを表示
- 初回かつ外部取得不可: `data/fallback.json` を表示
- フォールバック表示時は固定された古い生成日時をTTL判定に使わない
- PWAはクエリごとのAPI応答を無制限に保存せず、公開用の単一ニューススナップショットだけを保存
- HTMLナビゲーションとJS/CSS等のアセットでオフラインfallbackを分離

環境変数で変更できます。

```text
PORT=8787
HOST=127.0.0.1
CACHE_TTL_MS=600000
HARD_STALE_MS=86400000
FETCH_TIMEOUT_MS=8500
REFRESH_MIN_INTERVAL_MS=60000
FORCE_IP_INTERVAL_MS=300000
DATA_DIR=./data
TRUST_PROXY=0
ENFORCE_HTTPS=0
PUBLIC_ORIGIN=https://news.example.com
FALLBACK_FILE=./data/fallback.json
```

`HARD_STALE_MS` は互換用設定として保持しています。古いキャッシュを理由にユーザー応答を外部RSS取得待ちへ戻すことはありません。

外部公開する場合は `HOST=0.0.0.0` にしてください。TLS終端プロキシの直下では `TRUST_PROXY=1`、HTTPアクセスをHTTPSへ転送する場合は `ENFORCE_HTTPS=1` と実際のHTTPS公開元を示す `PUBLIC_ORIGIN` を設定します。`TRUST_PROXY=1` は、信頼できるリバースプロキシからだけ接続される環境で使用してください。手動更新は送信元ごとの間隔で制限され、状態は `DATA_DIR` に保存されます。複数コンテナで動かす場合は、全コンテナから同じ `DATA_DIR` を共有してください。別ホスト構成では、共有ファイルシステムまたは外部の分散ロック・レート制限基盤が必要です。

## GitHub Pages

`.github/workflows/pages.yml` は毎時、RSS取得・重複除去・ランキング生成を実行し、静的な `dist/` をGitHub Pagesへ公開します。ブラウザはサーバーAPIの代わりに `data/news.json` を読み込むため、Pages上でもニュース一覧・企業別・急上昇・記事詳細が動作します。

リポジトリの **Settings → Pages → Build and deployment → Source** は **GitHub Actions** を選択してください。初回公開はActionsの「Deploy GitHub Pages」を手動実行できます。

## Docker

```bash
docker build -t ai-brief-ultra .
docker volume create ai-brief-data
docker run --rm -p 8787:8787 -v ai-brief-data:/app/data ai-brief-ultra
```

コンテナ内ではrootではなくNode.js標準の `node` ユーザーでアプリを実行します。アプリ本体は読み取り専用権限で、`/app/data` だけを書き込み可能にしています。イメージにはヘルスチェックがあり、SIGTERM時は受付停止・状態保存を行って終了します。

## 公開運用時の注意

このプロジェクトは記事本文を転載せず、フィードから得られるタイトル、配信元、短い説明、時刻、分類情報を整理し、配信元へリンクします。

RSSから得た外部URLは、認証情報を含まない公開HTTPS URLのみ許可します。Google Newsの中継URLは、画面上でも「Google News経由」と明示します。

公開サービスとして運用する場合は、利用する各ニュース配信元・アグリゲーションサービスの利用条件、robots、商標表示、引用要件、アクセス頻度制限を別途確認してください。

Google News RSSは試作や低頻度用途に便利ですが、ニュースAPIのようなSLAや完全な鮮度保証はありません。商用・大規模運用では、契約したニュースAPIへの置き換えを推奨します。

## ディレクトリ

```text
ai-news-ultra/
├─ server.js
├─ test.js
├─ integration-test.js
├─ pages-test.js
├─ package.json
├─ start.bat
├─ start.sh
├─ Dockerfile
├─ .github/workflows/ci.yml
├─ .github/workflows/pages.yml
├─ scripts/
│  ├─ build-pages.js
│  ├─ generate-icons.js
│  └─ upgrade-html.js
├─ data/
│  ├─ fallback.json
│  └─ cache.json        # 初回ライブ取得成功後に自動生成
└─ public/
   ├─ index.html
   ├─ trending.html
   ├─ openai.html
   ├─ google.html
   ├─ anthropic.html
   ├─ company.html
   ├─ article.html
   ├─ about.html
   ├─ styles.css
   ├─ common.js
   ├─ home.js
   ├─ company.js
   ├─ trending.js
   ├─ article.js
   ├─ manifest.webmanifest
   └─ sw.js
```
