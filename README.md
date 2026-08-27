# AI BRIEF Ultra

アクセスするたびに最新のAIニュースを取得し、重複除去・急上昇ランキング・企業別ページ・記事詳細を提供するニュースサイトです。

## 主な機能

- 最新AIニュースの自動取得
- Google News RSSを複数クエリで並列取得（APIキー不要）
- 日本語圏 + グローバルAIニュースを統合
- タイトル正規化による完全重複除去
- 類似見出しのクラスタリング
- 急上昇スコアリング
  - 鮮度
  - 近似記事を報じた媒体数
  - 複数検索トピックで検出された広がり
  - 同一ニュースクラスタの記事量
- OpenAI専用ページ `openai.html`
- Google / DeepMind専用ページ `google.html`
- Anthropic専用ページ `anthropic.html`
- 記事詳細ページ `article.html?id=...`
- 関連記事表示
- 全文簡易検索 / カテゴリ絞り込み / 並び替え
- 手動「更新」ボタン
- 10分キャッシュ + stale-while-refresh方式
- 外部取得障害時：ディスクキャッシュ → 内蔵フォールバック
- PWAシェルキャッシュ
- レスポンシブUI
- ネオン・蛍光色・発光表現なし
- 広告SDK / 解析SDK / 外部フロントエンドライブラリなし
- Node.js標準機能のみ（npm install不要）

## Windowsで最短起動

1. Node.js 18以上をインストールします。
2. `start.bat` をダブルクリックします。
3. `http://127.0.0.1:8787` がブラウザで開きます。

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

```bash
npm run check
```

API動作確認：

- `GET /api/health`
- `GET /api/news?limit=20`
- `GET /api/news?company=openai`
- `GET /api/news?category=safety`
- `GET /api/news?q=Gemini`
- `GET /api/news?force=1&limit=1`
- `GET /api/trending?limit=15`
- `GET /api/article?id=ARTICLE_ID`
- `GET /api/meta`

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

Google News RSSは無料・認証不要ですが、提供仕様が将来変わる可能性があります。そのため本サイトは取得失敗時にニュース欄が空にならないよう、二段階のフォールバックを持ちます。

## キャッシュ

既定値：

- 通常キャッシュ: 10分
- 24時間以内のキャッシュ: 期限切れでも即時返却し、裏で更新
- 大規模取得失敗: 最後のディスクキャッシュを表示
- 初回かつ外部取得不可: `data/fallback.json` を表示

環境変数で変更できます。

```text
PORT=8787
HOST=127.0.0.1
CACHE_TTL_MS=600000
HARD_STALE_MS=86400000
FETCH_TIMEOUT_MS=8500
```

外部公開する場合は `HOST=0.0.0.0` にしてください。

## Docker

```bash
docker build -t ai-brief-ultra .
docker run --rm -p 8787:8787 ai-brief-ultra
```

## 公開運用時の注意

このプロジェクトは記事本文を転載せず、フィードから得られるタイトル、配信元、短い説明、時刻、分類情報を整理し、配信元へリンクします。

公開サービスとして運用する場合は、利用する各ニュース配信元・アグリゲーションサービスの利用条件、robots、商標表示、引用要件、アクセス頻度制限を別途確認してください。

Google News RSSは試作や低頻度用途に便利ですが、ニュースAPIのようなSLAや完全な鮮度保証はありません。商用・大規模運用では、契約したニュースAPIへの置き換えを推奨します。

## ディレクトリ

```text
ai-news-ultra/
├─ server.js
├─ package.json
├─ start.bat
├─ start.sh
├─ Dockerfile
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
