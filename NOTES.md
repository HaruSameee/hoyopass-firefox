# NOTES — API 調査メモ

HoYoLAB の API は公式ドキュメントが無く、以下はすべて OSS 実装からの裏取り。
「検証済み」は複数ソースで一致したもの、「単一ソース」は1件のみで見つかったもの、
「未検証」は実アカウントで叩いていない推測・ヒューリスティクス。

## ギフトコード一覧（検証済み）

- `GET https://hoyo-codes.seria.moe/codes?game=genshin | hkrpg | nap`
- レスポンス: `{"codes":[{"id":..,"code":"..","status":"OK","game":"genshin","rewards":".."}], "game":"genshin"}`
- ソース: https://github.com/seriaati/hoyo-codes 、HoyoLab-Utils も同じエンドポイントを使用
  (https://deepwiki.com/yuusukealmal/HoyoLab-Utils/3.1-redemption-code-handling)

## デイリーチェックイン（act_id は3タイトルとも複数ソースで一致＝検証済み）

POST + JSON body `{"act_id": "..."}`、レスポンスの `retcode === 0` が成功。

| ゲーム | エンドポイント | act_id |
|---|---|---|
| 原神 | `POST https://sg-hk4e-api.hoyolab.com/event/sol/sign` | `e202102251931481` |
| スターレイル | `POST https://sg-public-api.hoyolab.com/event/luna/os/sign` | `e202303301540311` |
| ゼンゼロ | `POST https://sg-public-api.hoyolab.com/event/luna/zzz/os/sign` | `e202406031448091` |

ソース:
- https://deepwiki.com/daydreamer-json/hoyo-auto-checkin/4.1-application-configuration
- https://pkg.go.dev/github.com/sparkeexd/hoyoapi@v0.6.0/internal/constants
- https://github.com/yuramedia/autoclaim-bot/blob/HEAD/.agents/skills/hoyolab-claim/SKILL.md
- https://deepwiki.com/seriaati/genshin.py/4-game-apis

付随事項:
- ヘッダ `x-rpc-signgame`: 原神 `hk4e`、スターレイル `hkrpg` は複数ソースで確認。
  ゼンゼロの値 `zzz` は **単一ソース**（torikushiii/hoyolab-auto の DeepWiki 解説）。
- 「受取済み」の扱い: 原神 sol では retcode `-5003` が受取済みとされる（コミュニティ実装の慣例）。
  luna 系（スターレイル/ゼンゼロ）の受取済み retcode は **未検証**のため、
  本実装ではメッセージ文字列マッチ（already / すでに 等）も併用している。
- セッションの前提: ブラウザ側に `ltoken_v2` + `ltuid_v2` のログインセッションが
  あること（複数ソースで一致）。ただし本実装はその値を **読まない**（後述の設計変更を参照）。
  fetch は `credentials: "include"` でブラウザにセッションを付けてもらい、
  ログイン判定は `getUserGameRolesByLtoken` の retcode で行う。
  実際に Firefox で HoYoLAB のログインセッションが API に届くかは **未検証**。

## コード交換

採用した方式（daydreamer-json/hoyo-auto-checkin の実装と一致）:

- `GET https://public-operation-{hk4e|hkrpg|nap}.hoyolab.com/common/apicdkey/api/webExchangeCdkeyHyl`
- パラメータ: `game_biz={hk4e|hkrpg|nap}_global`, `region`, `uid`, `cdkey`, `lang`, `sLangKey`
- 認証: ブラウザのログインセッションを `credentials: "include"` で付けてもらう
  （Cookie の値は読まない。uid / region はロール取得 API のレスポンスから得る）
- ソース: https://deepwiki.com/daydreamer-json/hoyo-auto-checkin/4.1-application-configuration
  および https://deepwiki.com/daydreamer-json/hoyo-auto-checkin/3.2-redeem-command

別の方式も存在する（本実装では不採用、フォールバック候補）:

- HoyoLab-Utils (Rust): `https://{domain}.hoyoverse.com/common/apicdkey/api/webExchangeCdkey` (GET) /
  `webExchangeCdkeyRisk` (POST)。こちらは `cookie_token_v2` / `account_id_v2` 系を使う。
  ソース: https://deepwiki.com/yuusukealmal/HoyoLab-Utils/3-redemption-system

### uid / region の取得（検証済み・ただし本実装の呼び出しは未検証）

- `GET https://api-account-os.hoyolab.com/binding/api/getUserGameRolesByLtoken`
  → `data.list[]` に `game_biz`, `game_uid`, `region`, `nickname`, `is_chosen` が返る。
- ソース: https://deepwiki.com/daydreamer-json/hoyo-auto-checkin/4.1-application-configuration

### 結果の分類（未検証のヒューリスティクス）

- `retcode === 0` → 成功（これは確実）
- `retcode === -1071 / -1073` → 認証エラーとして処理を止める（HoyoLab-Utils が -1071 を
  認証失敗として扱うことからの推定）
- それ以外はメッセージ文字列（already/使用済み、expire/期限、invalid/無効）で分類し、
  どれにも当たらないものは再試行可能エラーとして最大3回まで。

## 設計変更: Cookie を読まない方式への移行（2026-11-24）

初期実装はログイン確認のために `browser.cookies.getAll` で `ltoken_v2` /
`ltuid_v2` の **存在** を読んでいた（値を外部送信はしていなかった）が、
「ログイン情報・Cookie を読み取らない」というプライバシー表明と矛盾するため廃止した。

変更後の方式（ambient credentials）:

- manifest から `cookies` 権限を削除（残る権限は `alarms` / `storage` のみ）。
  クロスオリジン fetch に必要なのは `host_permissions` であり、これは維持する。
- 全 API 呼び出しは `fetch(..., { credentials: "include" })` のみ。
  ブラウザが既存セッションを自動で付け、コードは Cookie の値に一切触れない
  （読まない・ログしない・保存しない）。
- ログイン判定は Cookie の有無ではなく、認証付き API
  `getUserGameRolesByLtoken` へのプローブの retcode で行う
  （`retcode === 0` → ログイン中。その応答のロール一覧を uid / region 解決にも再利用し、
  プローブは1回の実行につき1回だけ共有する）。
  通信エラーは「未ログイン」と区別し、チェックインでは sign 自体の応答で
  最終判定する（プローブ失敗だけで未ログイン扱いにしない）。

### フォールバックが必要になり得る呼び出し（リスク記録）

現時点で ambient 方式で完結しない呼び出しは無いが、次の1件が将来リスクとして残る:

- **コード交換の hoyoverse.com 系方式への移行時**: 現在採用している
  `webExchangeCdkeyHyl`（hoyolab.com）は ambient セッションで動く前提。
  もし HoYoLAB 側が交換を HoyoLab-Utils 方式
  （`hoyoverse.com/common/apicdkey/api/webExchangeCdkey` / `webExchangeCdkeyRisk`）へ
  一本化し、`cookie_token_v2` の値をパラメータとして明示的に要求するようになった場合、
  その値の取得方法によっては Cookie 値の読み取りが必要になる可能性がある
  （`getCookieTokenByLtoken` の応答で得られるなら ambient のまま可能だが未検証）。
- その場合のフォールバックは「`cookies` 権限を再追加する」ことだが、
  同時にプライバシー表明（README / ストア説明の「Cookie を読み取らない」）を
  実態に合わせて変更しなければ表明が嘘になる。権限だけを黙って戻さないこと。

## 重複実行の防止（single-flight ロック、2026-11-24）

ポップアップを開くたびに再実行されているように見える問題への対策。
まず事実として、**ポップアップ自体は実行をトリガーしない**。
popup は storage の状態を表示し、`storage.onChanged` で再描画するだけであり、
実行が始まるのは「今すぐ実行」ボタンの明示的なクリック時のみ。
長時間（コード交換は1コードあたり数秒の pacing で全体で数分）にわたる実行が
進行中だと、開くたびにステータスが更新されて「また実行された」ように見える。

本当のリスクは background 側の重なりだった:
起動時キャッチアップやアラーム実行が進行中に手動実行が重なると、
同じコードを両方の実行が記録前に送信し得た。これを防ぐため:

- **種類別（checkin / codes）の single-flight ロック**を `storage.local` の
  `locks: { checkin?: {at, trigger}, codes?: {...} }` に置く。
  background は non-persistent でメモリ内フラグだけでは不足するため storage に置き、
  補助として同一インスタンス内では同期チェックできる in-memory の Set も併用する
  （アラーム・起動・メッセージは通常、生きている同一インスタンスへ配送されるため、
  現実的な重なりレースの大半はこれで閉じる。storage の get/set は原子的ではないので、
  別インスタンス同士が同一瞬間に獲得を競う窓は理論上残る）。
- ロックは実行開始時に取得し、`finally` で必ず解放する。
  **15分より古いロックは stale（クラッシュ／アンロードした実行の残骸）とみなして奪取する**。
  コード実行全体でも通常は数分で終わるため、15分は正当な実行に対する十分な余裕。
- **実行理由（trigger）**を全呼び出し元から伝搬する:
  `alarm`（定期）/ `startup`（起動時キャッチアップ）/ `installed`（インストール時）/ `manual`（手動）。
  獲得時に `lastTriggers` へ `{trigger, at}` を種類別に記録し、
  ポップアップのフッターで「最終実行（定期実行／起動時／インストール時／手動）」と表示する。
  ロックが生きている間は「実行中（手動・開始時刻）」と表示し、
  進行中の実行と新規の再実行を区別できるようにした。

## その他の未検証ポイント
- Firefox の event page 上で、コード間の数秒 pacing（setTimeout）がページのアンロードで
  切れないか。長時間の処理は途中で storage に保存しているため致命的ではない。
- HoYoLAB 側のレート制限・リスク検知（webExchangeCdkeyRisk への誘導）の発動条件。
- AMO 審査で host_permissions（*.hoyoverse.com 等）の説明を求められる可能性。
