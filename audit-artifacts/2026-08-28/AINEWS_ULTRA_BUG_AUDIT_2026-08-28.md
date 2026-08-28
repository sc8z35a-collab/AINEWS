# AINEWS 超ウルトラ・バグ監査報告

- 対象: `sc8z35a-collab/AINEWS`
- 対象ブランチ: `main`
- 対象コミット: `b7cf17a78e2ab514f0288ef04f5fa785866b4f32`
- 監査日: 2026-08-28 JST
- 方針: 修正は行わず、現行GitHubソースと実公開状態の診断に限定

## 結論

ローカルのNode.jsサーバーとしては起動し、構文検査と既存17回帰テストも通る。しかし、現在のGitHub Pages公開物はアプリではなくREADMEであり、公開されている `public/index.html` を直接開いてもニュースAPIが404になる。つまり「GitHubで公開されているAINEWS」としては、主要機能が動作していない。

加えて、ライブRSS取得では180件すべての要約に `&nbsp;` が文字として残り、要約内容も実質的に「見出し＋配信元」の繰り返しだった。キャッシュ更新、障害復旧、記事同一性、クラスタリング、PWAオフライン表示にも、CIでは検出できない重大な欠陥がある。

今回の集計は、欠陥・設計問題76項目と、独立したテスト／検証の盲点10項目、合計86項目。上位15件を先に示し、その後に全項目を分野別で記載する。「実際の公開URL、ライブRSS、ローカルHTTP、再現コード」で直接確認したものと、「実行経路がコード上確定しているもの」は確度欄と本文で区別した。

## 最重要15件

| No. | 重大度 | 確度 | 問題 | 主な根拠・影響 |
|---:|:---:|:---:|---|---|
| 1 | 致命的 | 実公開で再現 | GitHub PagesのトップがアプリではなくREADME | `https://sc8z35a-collab.github.io/AINEWS/` はREADMEをJekyll表示し、ニュース画面にならない。 |
| 2 | 致命的 | 実公開で再現 | 公開APIが存在しない | `https://sc8z35a-collab.github.io/AINEWS/api/news?limit=1` はHTTP 404。GitHub PagesはNode.jsの `server.js` を実行しない。 |
| 3 | 致命的 | 実公開で再現 | `public/index.html` を直接開いても全ニュース取得が失敗 | 画面は表示されるが、JSが絶対パス `/api/news` を呼び、404。画面に「ニュースAPIへ接続できませんでした」、Consoleにも404が出る。 |
| 4 | 致命的 | コード上確定 | 一部取得成功が正常キャッシュを破壊できる | 8件以上なら成功扱いで `cache.json` を上書きする。180件の正常キャッシュが、7フィード失敗＋1フィード8件という状態で8件へ縮退し得る。`server.js:469-497`。 |
| 5 | 高 | ライブ180件で再現 | 全要約に `&nbsp;` が文字として露出 | `decodeXml()` が `&nbsp;` を扱わない。今回取得した180/180件で発生。`server.js:61-70, 200-207`。 |
| 6 | 高 | ライブ180件で再現 | 要約が実質「見出し＋配信元」の重複 | Google Newsのdescriptionを正しく本文要約へ変換できず、全180件が見出しと媒体名の再表示。ニュース要約機能としてほぼ無効。 |
| 7 | 高 | 再起動試験で再現 | 10分以内の新鮮なディスクキャッシュでも再起動時に必ず全RSS再取得 | 17:10:29に保存後、約45秒後の再起動で17:11:14へ再取得・上書きされた。起動時にTTLを見ず `refreshNews()` する。`server.js:752-761`。 |
| 8 | 高 | コード上確定 | 初回障害時のフォールバックが回復しても最大10分再試行されない | failure backoffは15秒から始まるのに、`loadFallback()` が `generatedAt=now` とするため、`getNews()` はTTL内として10分間早期returnする。`server.js:414-424, 431-444, 510-519`。 |
| 9 | 高 | 再現コードあり | キャッシュschemaを一切検証していない | `schema:-999` のキャッシュも受理した。READMEの「cache schema検証」と不一致。`normalizePayload()` は `raw.schema` を見ない。`server.js:381-395`。 |
| 10 | 高 | 再現コードあり | 完全重複統合後の記事IDとURLが別記事由来のハイブリッドになる | 古い記事のIDを維持したまま、新しい記事のURL・媒体・日時へ差し替える。IDベースのブックマーク、詳細、キャッシュ同一性が崩れる。`server.js:248-292`。 |
| 11 | 高 | 再現コードあり | 1か月離れた同じ見出しを同一ニュースとしてクラスタ化 | 日時差制限がなく、古い別イベントが媒体数・件数を水増しする。再現では1か月差の2件が1クラスタ、スコア84.5。`server.js:295-353`。 |
| 12 | 高 | 再現コードあり | greedyクラスタが閾値未満の記事同士を同じクラスタへ橋渡しする | A↔B、B↔Cは類似でもA↔C=0.428（閾値0.48未満）の3件が1クラスタになった。代表との逐次比較だけでクラスタ整合性を再検証しない。 |
| 13 | 高 | 再現コードあり | GPT-4とGPT-4oのtoken集合が完全一致 | `4o` の `o` が1文字英字として落ち、両モデルを区別できない。モデルニュースの重複・関連記事・急上昇が混ざる。`server.js:110-132`。 |
| 14 | 高 | ブラウザー計測 | 初期画面で180カードを一括生成し、検索1回で全DOMを再生成 | 375px級モバイルで180カード、ページ高約66,447px。検索入力処理は約253msで、入力ごとに全カードを `innerHTML` 再構築する。`public/home.js:4-6`。 |
| 15 | 高 | コード上確定 | オフラインAPIキャッシュが古い `mode:live` をそのまま返す | Service Workerはネットワーク失敗時に保存済みJSONを無加工で返す。UIはオフラインでも「自動取得：正常」「LIVE」と誤表示し得る。`public/sw.js:6-10`, `public/common.js:18-19`。 |

## 全指摘一覧

### A. 公開・配信・PWA

1. **[致命的／再現] GitHub PagesトップがREADME。** ルートに公開用 `index.html` がなく、JekyllがREADMEをサイト化している。
2. **[致命的／再現] GitHub Pagesの `/api/news` が404。** 静的ホスティングとNodeバックエンドが混在している。
3. **[致命的／再現] `/AINEWS/public/index.html` もニュース取得不能。** `api('/api/...')` がドメインルートへ飛ぶ。
4. **[高] Service WorkerのSHELLがすべて `/` 起点。** project siteの `/AINEWS/public/` scopeから外れ、`cache.addAll()` のどれかが404ならinstall全体が失敗する。`public/sw.js:1-4`。
5. **[高] manifestの `start_url` が `/index.html`。** GitHub project siteからユーザーサイトのルートへ脱出する。`public/manifest.webmanifest`。
6. **[高] PWA manifestに `icons` がない。** 192px／512px icon要件を満たさず、Chrome系で通常のPWA installabilityを満たさない。
7. **[中] APIキャッシュがquery文字列単位で無制限増加。** `q`, `source`, `offset`, `limit`, `force=1` の組合せごとにDATA_CACHE entryが増え、期限・最大数・削除処理がない。
8. **[中] `Cache-Control:no-store` のAPI応答をService Workerが明示的に `cache.put()`。** サーバー側のno-store意図と矛盾する。
9. **[高] オフラインキャッシュにoffline/stale印を付けない。** 古いliveレスポンスをUIが正常・最新と表示する。
10. **[中] HTTP 500/503時は保存済みAPIへfallbackしない。** `fetch()` が成功してnon-OKならそのまま返し、catchに入らない。`public/sw.js:7`。
11. **[中] navigation cacheもquery付きURLごとに増加。** `article.html?id=...` ごとの同一shellが別entryとして保存され得る。
12. **[低] indexだけService Worker登録を二重実行。** `common.js` とindex末尾のinline scriptの両方で登録する。
13. **[中] shell cache versionは手動文字列だけ。** asset変更とversion bumpの連動がなく、更新直後に旧JS・新HTMLの混在が起こり得る。

### B. RSS取得・ニュースデータ品質

14. **[高／再現] ライブ180件すべてのsummaryに `&nbsp;` が残る。** XML entity decoder不足。
15. **[高／再現] 全180件のsummaryが見出し＋媒体名の重複。** 実質的な要約を取得できていない。
16. **[中／再現] 全180件の `url` がGoogle News redirect。** 「配信元の記事を開く」は直接URLではなくGoogle News経由。sourceUrlは媒体トップで、記事URL解決には使っていない。
17. **[中] response size上限を全body読込後に確認。** 5MB超や自動展開後の圧縮爆弾をメモリへ載せてから拒否する。`server.js:230-242`。
18. **[中] RSSのContent-Typeを確認しない。** HTMLのエラーページ、CAPTCHA、JSON等もXMLとして解析してから0件扱いになる。
19. **[中] XMLを正規表現だけで解析。** CDATA内の `</item>`、namespace、attribute variation、entity variationに弱い。
20. **[中] 各feedを先頭45 `<item>` へ切ってから検証。** 先頭45件が壊れていて46件目以降が正常でもfeed全体を失敗扱いにする。`server.js:191-227`。
21. **[低] `<source url='...'>` のsingle quoteやattribute順違いを扱わない。** source URLを失う。
22. **[中／再現] 不正な実在しない日付を正規化して受理。** `2026-02-30` が `2026-03-02` になった。`Date.parse` に厳密なcalendar validationがない。
23. **[中] 15分超未来の記事を拒否せず「現在時刻」へ改ざん。** 異常データが最新・鮮度満点としてランキング上位へ入る。
24. **[低] 未来15分以内はそのまま受理。** キャッシュageが0へ丸められ、TTLが実質延長される。
25. **[低] UTF-16の固定長sliceで絵文字を途中切断可能。** title 600、summary 560、UI trimでunpaired surrogateが生じ得る。

### C. 分類・重複除去・ランキング

26. **[高／再現] 企業名の同音異義語を誤分類。** `Claude Monet→Anthropic`, `Gemini horoscope→Google`, `ancient codex→OpenAI`, `Amazon rainforest→Amazon`, `Blackwell school→NVIDIA` を再現。
27. **[中] 分類対象がtitle＋sourceだけ。** summaryにだけ企業・製品・カテゴリがある記事は未分類になる。`server.js:155-176`。
28. **[高／再現] GPT-4とGPT-4o token集合が同一。** モデル版違いを消す。
29. **[高／再現] exact merge後にIDだけ旧記事、URL等は新記事。** identity hybrid。
30. **[中] exact mergeは同じ見出しの別イベントも統合。** 日時・URL・GUIDの整合性を見ず、正規化titleだけをキーにする。
31. **[高／再現] クラスタに日時窓がない。** 1か月差でも同一扱い。
32. **[高／再現] greedy bridgeで内部不整合クラスタ。** 全pairが閾値を満たす保証がない。
33. **[中] クラスタ代表tokenを最新記事へ差し替えるが既存memberを再検証しない。** 代表変更で過去memberが代表と非類似になっても残る。
34. **[中] mentionCountは同じ記事が複数検索feedで拾われた回数も加算。** 市場の報道量ではなく、自前query overlapでvolumeが上がり得る。
35. **[中] 180件へ新着順truncateしてから企業ページ・ランキングを作る。** 今回は各feed45件取得なのに保持後はopenai 17、google 20、anthropic 16、infra 14、safety 16、research 13。7日検索の専門記事が最新の総合記事に押し出される。
36. **[中] `/api/meta` の配信元数が代表 `source` だけを数える。** exact mergeで保持した `sourceNames` を無視し、画面の配信元総数を過少計上する。
37. **[中] fallback内の特定記事リンクがニュース一覧URL。** 記事固有ページが存在しても `/news/` や `/blog/` へ飛び、記事へ到達しにくい。

### D. キャッシュ・障害復旧・同時実行

38. **[致命的] 8件以上なら低品質な部分取得で正常cacheを上書き。** 以前の180件を保護しない。
39. **[高／再現] 起動時にfresh cacheでも必ず全feedを再取得。** TTL・min intervalを無視。
40. **[高] fallback復旧retryが実質10分。** 15秒backoff設計と矛盾。
41. **[中] stale diskへfallbackしたとき `fetchedAt=now`。** 実データ取得には失敗しているのに「取得時刻」だけ新しくなる。`server.js:470-476`。
42. **[中] fallbackも `generatedAt`/`fetchedAt=now`。** 内蔵データが古くても「最終取得 今」と見える。元日時 `contentGeneratedAt` はAPI metaへ出さない。
43. **[高] backoff・refresh cooldown・force IP rate limitがプロセス再起動で全消失。** 再起動loopでGoogle Newsへの負荷保護を回避する。
44. **[中] 複数replicaでrefresh lockもrate limitも共有されない。** 各instanceが8feedを独立取得し、cacheも競合・分断する。
45. **[高／再現] cache schemaを無視。** 古い／未知形式を受理する。
46. **[中] cache readの全例外を無言でnull化。** JSON破損、権限、I/O障害の区別もログもなくfallbackへ落ちる。`server.js:398-401`。
47. **[低] cache正規化の個別文字列長が未制限。** locale、feedKeys、feedLabels、sourceNamesの各文字列が巨大でも通る。
48. **[中] memoryCacheをdisk writeより先にlive更新。** 書込失敗中もhealth/APIはlive表示し、再起動すると消える。
49. **[低] rename前にfile fsync、rename後にdirectory fsyncなし。** OSクラッシュ時のdurabilityを厳密には保証しない。

### E. API・HTTP・セキュリティ

50. **[中] 更新という副作用をGET `/api/news?force=1` で実行。** 他サイトの画像・link prefetch等からcross-originで発火させ、global cooldownを消費できる。
51. **[中] force更新が全利用者共通のglobal cooldown。** 1人の更新で他全員がthrottledになる。
52. **[中] reverse proxy配下でsocketのproxy IPしか見ない。** 全利用者が同一clientとして5分制限を共有しやすい。
53. **[中] 複数instanceではforce制限をround-robinで回避可能。** rate limit storeがprocess local。
54. **[低] IP mapは1000を超えるまで掃除しない。** 1000件以下の古いentryは永久保持。
55. **[中／再現] gzip negotiationがRFC優先順位を誤る。** `Accept-Encoding: *;q=1, gzip;q=0` にも `Content-Encoding:gzip` を返した。`server.js:580-586`。
56. **[低] HEADのJSONにContent-Lengthがない。** GETとのmetadata parityが弱い。
57. **[中] 安全URL検査がschemeだけ。** credentials付き、loopback、private IP、cleartext HTTPも「安全」として外部リンク表示可能。再現: `http://user:pass@127.0.0.1/admin` を受理。
58. **[中] CSP・frame-ancestors／X-Frame-Optionsなし。** UIを第三者frameへ埋め込め、GET force更新との組合せでclickjacking余地がある。
59. **[低] HTTPS強制はアプリ側にない。** reverse proxy設定を誤るとHTTPでも同じページと外部HTTPリンクを提供する。
60. **[低] JSONエラー応答の500詳細はproductionで隠すが、request IDがない。** 障害追跡が難しい。

### F. UI・性能・アクセシビリティ

61. **[高／計測] 180カードを初期一括描画。** モバイル相当で約66,447pxの長大DOM。pagination／virtualizationなし。
62. **[高／計測] 検索入力ごとに180件filter/sort＋innerHTML全置換。** 1回約253ms。IME入力や低速端末で引っ掛かる。
63. **[中] 記事から戻ると検索語、filter、sort、scroll位置を復元しない。** 一覧探索をやり直す必要がある。
64. **[中] 小さい通常文字のcontrast不足。** `#73787a` on `#f2efe8` は約3.89:1、on `#fffdf8` は約4.40:1。通常文字AA 4.5:1を下回る。trend index `#9a958d` on paperは約2.93:1。
65. **[中] keyboard focus-visibleの明示スタイルがない。** hover中心で、現在focusが判別しにくい。
66. **[低] skip-to-contentがない。** 各ページで長い共通navigationを毎回tab移動する。
67. **[低] category filterに `aria-pressed` がない。** 見た目のactive状態をscreen readerへ伝えない。
68. **[低] result count／news grid更新にlive regionがない。** 検索結果変化を読み上げない。
69. **[低] mobile menuはEscape／outside clickで閉じない。** `aria-expanded` は更新するがkeyboard操作が不十分。
70. **[低] JavaScript無効時はskeletonのまま。** `<noscript>` fallbackがない。

### G. 起動・Docker・CI

71. **[中] `start.bat` が常に `http://127.0.0.1:8787` を先に開く。** `PORT` を変更すると誤URL、port競合や起動失敗でもエラー画面を先に見せる。
72. **[高] READMEのDocker例が `--rm` かつvolumeなし。** container終了で `data/cache.json` を失い、disk cacheの再起動耐性が消える。
73. **[中] container runtime userがアプリ全体を書換可能。** `chown -R node:node /app` でserver sourceまでnode所有。書込対象はdataだけに絞るべき。
74. **[低] `node:22-alpine` がdigest未固定。** 同じcommitでも将来異なるbase imageになる。
75. **[中] Docker HEALTHCHECKなし。** orchestratorがHTTP readinessを標準設定だけでは判定できない。
76. **[中] graceful SIGTERM shutdownなし。** deploy時にkeep-alive requestや進行中refreshを待たず終了する。

## テスト／検証の盲点

1. 既存テストは17件で、主にexport済みpure function。HTTP serverのend-to-end testがない。
2. GitHub Pages deployment後のURL smoke testがない。CIは緑でも本番トップがREADME、APIは404だった。
3. Service Worker install、offline reload、cache expiry、mode表示のbrowser testがない。
4. ライブGoogle News RSSのcontract testがなく、180/180件のsummary崩壊を検知できない。
5. cache corruption／schema migration／permission failureのtestがない。
6. partial feed failureで正常cacheを保護するregression testがない。
7. fresh cacheを持ったprocess restart testがない。
8. clusteringの時間窓、非推移類似、model suffix差分のtestがない。
9. accessibility、mobile performance、180カード描画のbudgetがない。
10. Docker build／run／persistent volume／non-root write boundaryのCIがない。

## 実施した検証

| 検証 | 結果 |
|---|---|
| Git working tree | clean。対象commit固定済み |
| GitHub Actions | 現行commitのNode 18 / 22両job success |
| Node構文検査 | `server.js`、全public JS、`test.js` success |
| 既存回帰テスト | 17/17 success |
| ローカルHTTP起動 | success、`/api/health` 200、live 180件 |
| GitHub Pagesトップ | HTTP 200だがREADME表示 |
| GitHub Pages API | HTTP 404 |
| GitHub Pages `/public/index.html` | shell表示、news API 404、エラーUI再現 |
| ライブデータ品質 | 180/180 `&nbsp;`、180/180 Google News URL、general-only 103、companyなし112 |
| restart freshness | fresh cacheでも約45秒後のrestartで再取得を再現 |
| mobile layout | 横overflowなし。ただし180 cards、約66k px、検索約253ms |
| Docker実ビルド | このホストにDockerがなく未実施 |

## 良かった点

- Node外部依存0で、依存パッケージ由来の脆弱性面は小さい。
- 現行17回帰テストと構文検査は成功。
- DOMへ入れるRSS由来文字列は概ね `esc()` 済みで、今回の範囲では明白なstored/reflected XSSは確認できなかった。
- URL scheme検査、API数値境界、atomic rename、refreshPromiseによる単一process内の同時refresh統合は実装されている。
- 375px級表示で横スクロールは発生しなかった。
- Dockerはroot実行ではない。

## 修正優先順

1. **公開構成を決める。** Node serverを動かすhostingへdeployするか、GitHub Pages用に静的API／事前生成JSONへ設計変更する。root、base path、API base URLを統一する。
2. **RSS descriptionを正しく解析。** HTML entity decoder、Google News description構造、記事URL解決、要約欠如時の表示を修正し、live contract testを追加する。
3. **cache保護。** partial refreshは旧cacheとquality比較し、十分なsource数・記事数を満たさない限り上書きしない。schema検証、fresh restart、fallback retryを直す。
4. **記事identityとclusterを再設計。** canonical URL／GUIDを主IDにし、時間窓、model version token、complete-linkまたはunion-find等でクラスタ整合性を保証する。
5. **PWAを正す。** relative/base-aware URL、icons、offline mode marker、cache TTL／上限、non-OK fallback、deployment browser testを入れる。
6. **性能とアクセシビリティ。** pagination/virtual list、debounce、state restoration、contrast、focus-visible、ARIAを追加する。
7. **CIを本番志向へ。** GitHub Pages／hosting smoke、HTTP integration、live fixture contract、Docker、restart、offline browser testを追加する。

## 参照URL

- 現行リポジトリ: https://github.com/sc8z35a-collab/AINEWS
- 現在のGitHub Pagesトップ: https://sc8z35a-collab.github.io/AINEWS/
- 公開APIの404再現URL: https://sc8z35a-collab.github.io/AINEWS/api/news?limit=1
- 公開された静的shell: https://sc8z35a-collab.github.io/AINEWS/public/index.html
- 現行commitのCI run: https://github.com/sc8z35a-collab/AINEWS/actions/runs/33093778917
- GitHub Pagesのstatic publishing説明: https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site
- Chromeのinstallable manifest要件: https://developer.chrome.com/docs/lighthouse/pwa/installable-manifest

## 監査上の注意

この報告は現行commitに対する診断であり、修正済みの主張ではない。Docker実ビルド、複数instance実運用、長時間load test、実端末のPWA install promptは今回未検証。これらは「未検証」として残している。
