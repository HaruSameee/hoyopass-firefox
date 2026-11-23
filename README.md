# HoYoPass for Firefox（非公式）

原神・崩壊：スターレイル・ゼンレスゾーンゼロの HoYoLAB デイリーログインボーナスと
交換コード（ギフトコード）を、Firefox を開いておくだけで自動で受け取る拡張機能です。
Chrome 拡張「HoYoPass」の挙動を参考にしたクリーンルーム再実装で、元のコードは含みません。

> **Disclaimer**: 非公式のファンメイドプロジェクトです。COGNOSPHERE / miHoYo（HoYoverse）
> とは一切関係ありません。HoYoLAB の非公開 API を利用しているため、仕様変更で
> 動かなくなることがあります。利用は自己責任でお願いします。

## 機能

- デイリーチェックイン: 毎日 01:05（ローカル時刻）ごろに自動実行、起動時にも未実行なら追いつき実行
- 交換コード: 3時間ごとに [hoyo-codes](https://github.com/seriaati/hoyo-codes) の
  公開 API を確認し、新しいコードを自動交換。交換履歴はローカルに保存され、
  済んだコードを再送信しません
- ゲームごとにチェックイン／コード交換の ON/OFF、ポップアップから今すぐ実行

## プライバシーとセキュリティ

- パスワードや Cookie を拡張機能が読み取ることはありません。外部サーバーへ
  送信することもありません（そもそもコードが Cookie の値に触れません）
- 通信先は公式の HoYoLAB / HoYoverse API と、コード一覧の取得元である
  hoyo-codes.seria.moe のみです。API 認証はブラウザに既にあるログイン
  セッションをブラウザ自身に付けてもらう方式（`credentials: "include"`）で、
  ログイン状態の判定も API の応答（retcode）で行います
- 設定や受取履歴はすべてお使いの PC のローカル（拡張機能のストレージ）に
  のみ保存されます
- 匿名利用統計を含む、いかなる解析・テレメトリ送信も行いません

## 開発

```sh
npm install
npm run check   # 型チェック
npm run build   # src/*.ts -> background.js / popup.js
```

## Firefox への一時読み込み（開発用）

1. `npm run build` でビルドする
2. Firefox で `about:debugging` →「この Firefox」→「一時的なアドオンを読み込む」
3. このフォルダの `manifest.json` を選ぶ
4. HoYoLAB にログインした状態で、ツールバーのアイコンからポップアップを開く

**注意**: 一時読み込みは Firefox を再起動すると消えます。常駐させるには
AMO（addons.mozilla.org）での署名が必要です（公開・非公開どちらの配布でも可）。
`manifest.json` の `browser_specific_settings.gecko.id` は仮の値
（`hoyopass-firefox@aynm.dev`）なので、AMO 申請前に自分のものへ変えてください。

## 未検証のポイント

実アカウントでの動作確認がまだ済んでいません。特に:

- Firefox で HoYoLAB のログインセッションが拡張機能の fetch（`credentials: "include"`）で
  API に正しく届くか
- スターレイル／ゼンゼロの「受取済み」応答の retcode
- 詳細は [NOTES.md](NOTES.md) を参照
