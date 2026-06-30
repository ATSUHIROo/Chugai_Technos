# 保守ナレッジ閲覧サイト ― GitHub Pages 配置手順

設備故障・対応履歴のデータベースを、タブレットのブラウザから閲覧・検索できる
静的サイト一式です。サーバー不要で、GitHub Pages にそのまま置けます。

## このフォルダの中身（すべて必要）

| ファイル | 役割 |
|---|---|
| `index.html` | 閲覧・検索画面。開くと同じフォルダの `incident_db.sqlite` を自動で読み込みます。 |
| `incident_db.sqlite` | データベース本体。**更新したいときはこのファイルを差し替えるだけ。** |
| `sql-wasm.js` / `sql-wasm.wasm` | ブラウザ内でSQLiteを動かすエンジン（同梱済み。CDN不要・オフライン可）。 |
| `.nojekyll` | GitHub Pages が `.wasm` 等をそのまま配信するためのマーカー（中身は空でOK）。 |

毎回DBファイルを選ぶ必要はありません。`index.html` と同じ場所に `incident_db.sqlite`
があれば自動で読み込みます（http/https 配信時）。

---

## GitHub Pages に置く（ブラウザだけで完結する手順）

1. GitHub にログインし、新しいリポジトリを作成（例: `incident-db`）。
2. 作成したリポジトリの「Add file ▸ Upload files」で、**このフォルダ内の全ファイル**
   （`index.html`, `incident_db.sqlite`, `sql-wasm.js`, `sql-wasm.wasm`, `.nojekyll`）を
   アップロードして Commit。
3. リポジトリの「Settings ▸ Pages」を開く。
4. 「Build and deployment」の Source を **Deploy from a branch** にし、
   Branch を **main / (root)** にして Save。
5. 1分ほど待つと、ページのURL（`https://<ユーザー名>.github.io/<リポジトリ名>/`）が表示されます。
6. そのURLをタブレットのブラウザで開けば、検索画面が出てDBが自動で読み込まれます。
   ホーム画面に追加しておくとアプリのように使えます。

### データを更新するとき
新しい `incident_db.sqlite` を同じリポジトリにアップロードして上書きCommitするだけ。
ページを再読み込みすれば最新データが表示されます（画面側の変更は不要）。

---

## 動作の前提とよくある点

- **自動読み込みは http/https 配信時に動作します。** GitHub Pages やローカルの
  簡易サーバー（`python -m http.server`）ではそのまま自動読込されます。
- `index.html` をPCでダブルクリックして開く（`file://`）と、ブラウザの制限で
  自動読込ができません。その場合は画面の「手動でファイルを選択」から `incident_db.sqlite`
  を選べば動きます（フォールバックを用意済み）。
- すべての処理はタブレット／PCのブラウザ内で完結し、データは外部に送信されません。

---

## ⚠ 公開範囲についての注意（重要）

GitHub Pages を**無料の公開（public）リポジトリ**で使うと、ページだけでなく
`incident_db.sqlite` も **URLを知っていれば誰でもダウンロードできる状態** になります。
設備の故障・対応履歴が社外秘に当たる場合は、公開リポジトリでの配信は避けてください。

社内限定で使いたい場合の選択肢:
- **GitHub Enterprise / 組織の限定公開 Pages**（アクセス制御つき）
- **社内Webサーバー＋VPN**（前回ご説明した構成。同じ一式をそのまま置けます）
- ひとまず**ローカルやLAN内だけ**で使う（`python -m http.server` で配信）

中身を確認したうえで、公開してよいデータか必ず判断してください。
