/**
 * Popup: per-game toggles, run status, active code counts.
 * Reads state straight from browser.storage.local; asks the background
 * to run via runtime messaging.
 */
const ext = globalThis.browser ?? globalThis.chrome;
const GAMES = [
    { key: "genshin", label: "原神" },
    { key: "hsr", label: "崩壊：スターレイル" },
    { key: "zzz", label: "ゼンレスゾーンゼロ" },
];
const RESULT_LABEL = {
    success: "成功",
    already: "受取済み",
    done: "完了",
    nothing_new: "新しいコードなし",
    not_logged_in: "未ログイン",
    no_role: "キャラクター未検出",
    auth_error: "認証エラー",
    error: "エラー",
};
function fmtTime(at) {
    if (!at)
        return "未実行";
    return new Date(at).toLocaleString("ja-JP");
}
function statusLine(run, kind) {
    const r = run?.[kind];
    if (!r)
        return kind === "checkin" ? "チェックイン: 未実行" : "コード: 未実行";
    const label = RESULT_LABEL[r.result] ?? r.result;
    const head = kind === "checkin" ? "チェックイン" : "コード";
    return `${head}: ${label}（${fmtTime(r.at)}）${r.message ? `\n　${r.message}` : ""}`;
}
async function render() {
    const raw = await ext.storage.local.get([
        "settings",
        "runs",
        "lastCheckinRun",
        "lastCodesRun",
        "stats",
    ]);
    const settings = raw.settings ?? { games: {} };
    const runs = raw.runs ?? {};
    const stats = raw.stats ?? { totalRedeemed: 0, activeCounts: {} };
    const container = document.getElementById("games");
    container.innerHTML = "";
    for (const game of GAMES) {
        const gs = settings.games?.[game.key] ?? { checkin: true, codes: true };
        const div = document.createElement("div");
        div.className = "game";
        const h = document.createElement("h2");
        const name = document.createElement("span");
        name.textContent = game.label;
        const count = document.createElement("span");
        count.className = "count";
        const active = stats.activeCounts?.[game.key];
        count.textContent = active == null ? "" : `有効コード ${active}件`;
        h.append(name, count);
        const row = document.createElement("div");
        row.className = "row";
        for (const kind of ["checkin", "codes"]) {
            const label = document.createElement("label");
            const box = document.createElement("input");
            box.type = "checkbox";
            box.checked = Boolean(gs[kind]);
            box.addEventListener("change", async () => {
                const cur = await ext.storage.local.get(["settings"]);
                const s = cur.settings ?? { games: {} };
                s.games = s.games ?? {};
                s.games[game.key] = {
                    checkin: true,
                    codes: true,
                    ...s.games[game.key],
                    [kind]: box.checked,
                };
                await ext.storage.local.set({ settings: s });
            });
            label.append(box, document.createTextNode(kind === "checkin" ? "チェックイン" : "コード交換"));
            row.appendChild(label);
        }
        const status = document.createElement("div");
        status.className = "status";
        status.textContent =
            statusLine(runs[game.key], "checkin") +
                "\n" +
                statusLine(runs[game.key], "codes");
        div.append(h, row, status);
        container.appendChild(div);
    }
    const footer = document.getElementById("footer");
    footer.textContent =
        `最終チェックイン実行: ${fmtTime(raw.lastCheckinRun)}\n` +
            `最終コード実行: ${fmtTime(raw.lastCodesRun)}\n` +
            `累計交換成功: ${stats.totalRedeemed ?? 0}件`;
}
document.getElementById("run-now").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = "実行中…";
    try {
        await ext.runtime.sendMessage({ type: "run-now", scope: "all" });
    }
    finally {
        btn.disabled = false;
        btn.textContent = "今すぐ実行（チェックイン＋コード）";
        await render();
    }
});
ext.storage.onChanged?.addListener(() => void render());
void render();
export {};
