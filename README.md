原神・崩壊：スターレイル・ゼンレスゾーンゼロの HoYoLAB デイリーログインボーナスと交換コードを、Firefox を開いておくだけで自動で受け取ります。

■ できること
・毎日 01:05 ごろにログボを自動受取。その時刻に Firefox が起動していなくても、次に起動したときに受け取り損ねた分をまとめて受け取ります
・3時間ごとに新しい交換コードを確認し、自動で引き換え
・ゲームごとに ON / OFF を切り替え可能
・ポップアップから手動実行と、実行結果の確認ができます

■ 使い方
Firefox で HoYoLAB に一度ログインしておくだけです。

■ プライバシー
・パスワードや Cookie の値を読み取りません。ログイン中のセッションはブラウザがそのまま使います
・通信先は HoYoLAB / HoYoverse の公式 API と、交換コード一覧の取得元 hoyo-codes.seria.moe だけです
・設定と履歴はお使いの PC にだけ保存されます。解析やテレメトリは一切送信しません

■ 権限が必要な理由
・hoyolab.com / hoyoverse.com / mihoyo.com：ログボ受取とコード交換の API を呼ぶため
・hoyo-codes.seria.moe：交換コード一覧を取得するため
・alarms：定期実行のため ／ storage：設定と履歴を保存するため

■ 注意
非公式のファンメイド拡張で、COGNOSPHERE / miHoYo（HoYoverse）とは一切関係ありません。Chrome 版「HoYoPass」の作者とも無関係です。HoYoLAB の非公開 API を使っているため、仕様変更で動かなくなることがあります。利用は自己責任でお願いします。

## Build

TypeScript（strict）のみで書かれています。バンドラ・ミニファイア・テンプレートエンジンはいずれも使っていません。

必要なもの: Node.js 18 以上

```sh
npm ci          # devDependency の TypeScript のみをインストール
npm run build   # src/*.ts -> background.js / popup.js（tsc のみ）
npm run check   # 型チェック（出力なし）
```

配布パッケージは `manifest.json` / `background.js` / `popup.js` / `popup.html` の4ファイルで構成されます（`popup.html` は手書きで、生成物ではありません）。
