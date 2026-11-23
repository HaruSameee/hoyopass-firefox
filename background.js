/**
 * HoYoPass for Firefox (unofficial) — background (event page / service worker)
 *
 * Clean-room reimplementation. All durable state lives in browser.storage.local;
 * nothing important is kept in memory because the background context is
 * non-persistent and can be unloaded at any time.
 *
 * API details and their sources are documented in NOTES.md.
 *
 * Privacy: this code NEVER reads, logs, or stores cookie values. Every API
 * request uses fetch with credentials:"include", so the browser attaches
 * the user's existing HoYoLAB session automatically (ambient credentials).
 * Login state is detected from API retcodes, not from cookie presence.
 */
const ext = globalThis.browser ?? globalThis.chrome;
const GAMES = [
    {
        key: "genshin",
        label: "原神",
        codesGame: "genshin",
        biz: "hk4e",
        gameBiz: "hk4e_global",
        signUrl: "https://sg-hk4e-api.hoyolab.com/event/sol/sign",
        actId: "e202102251931481",
        signGame: "hk4e",
        redeemUrl: "https://public-operation-hk4e.hoyolab.com/common/apicdkey/api/webExchangeCdkeyHyl",
    },
    {
        key: "hsr",
        label: "崩壊：スターレイル",
        codesGame: "hkrpg",
        biz: "hkrpg",
        gameBiz: "hkrpg_global",
        signUrl: "https://sg-public-api.hoyolab.com/event/luna/os/sign",
        actId: "e202303301540311",
        signGame: "hkrpg",
        redeemUrl: "https://public-operation-hkrpg.hoyolab.com/common/apicdkey/api/webExchangeCdkeyHyl",
    },
    {
        key: "zzz",
        label: "ゼンレスゾーンゼロ",
        codesGame: "nap",
        biz: "nap",
        gameBiz: "nap_global",
        signUrl: "https://sg-public-api.hoyolab.com/event/luna/zzz/os/sign",
        actId: "e202406031448091",
        signGame: "zzz",
        redeemUrl: "https://public-operation-nap.hoyolab.com/common/apicdkey/api/webExchangeCdkeyHyl",
    },
];
const ROLES_URL = "https://api-account-os.hoyolab.com/binding/api/getUserGameRolesByLtoken";
const CODES_API = "https://hoyo-codes.seria.moe/codes";
const DEFAULT_SETTINGS = {
    games: Object.fromEntries(GAMES.map((g) => [g.key, { checkin: true, codes: true }])),
};
async function loadState() {
    const raw = await ext.storage.local.get([
        "settings",
        "runs",
        "lastCheckinRun",
        "lastCodesRun",
        "attempts",
        "stats",
    ]);
    return {
        settings: {
            games: { ...DEFAULT_SETTINGS.games, ...(raw.settings?.games ?? {}) },
        },
        runs: raw.runs ?? {},
        lastCheckinRun: raw.lastCheckinRun,
        lastCodesRun: raw.lastCodesRun,
        attempts: raw.attempts ?? {},
        stats: raw.stats ?? { totalRedeemed: 0, activeCounts: {} },
    };
}
async function saveState(patch) {
    await ext.storage.local.set(patch);
}
// ---------------------------------------------------------------------------
// Helpers: jitter, backoff, fetch
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base, spread = 0.5) => base * (1 - spread / 2 + Math.random() * spread);
/** GET/POST JSON with exponential backoff + jitter. Used only for idempotent
 *  reads (code list, role lookup) — never for sign/redeem submissions. */
async function fetchJsonWithRetry(url, init, tries = 3) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
        try {
            const res = await fetch(url, { credentials: "include", ...init });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            return await res.json();
        }
        catch (e) {
            lastErr = e;
            if (i < tries - 1)
                await sleep(jitter(1000 * 2 ** i));
        }
    }
    throw lastErr;
}
async function probeSession() {
    let json;
    try {
        json = await fetchJsonWithRetry(ROLES_URL, { method: "GET" });
    }
    catch (e) {
        return { status: "error", message: String(e) };
    }
    if (json?.retcode === 0) {
        return { status: "ok", roles: json?.data?.list ?? [] };
    }
    return {
        status: "not_logged_in",
        message: json?.message ?? `retcode ${json?.retcode}`,
    };
}
/** Picks this game's role out of a session probe's role list. */
function pickRole(game, list) {
    const mine = list.filter((r) => r.game_biz === game.gameBiz);
    if (mine.length === 0)
        return null;
    const chosen = mine.find((r) => r.is_chosen) ?? mine[0];
    return {
        gameUid: String(chosen.game_uid),
        region: String(chosen.region),
        nickname: chosen.nickname,
    };
}
/** Resolves uid/region for a game. Uses a shared session probe when one is
 *  given (one probe per run, not one per game); otherwise probes itself.
 *  Throws on transport error, returns null when logged in but the account
 *  has no character for this game, or when not logged in. */
async function fetchRole(game, probe) {
    const p = probe ?? (await probeSession());
    if (p.status === "error")
        throw new Error(p.message);
    if (p.status === "not_logged_in")
        return null;
    return pickRole(game, p.roles);
}
// ---------------------------------------------------------------------------
// Daily check-in
// ---------------------------------------------------------------------------
function classifySign(json) {
    const retcode = json?.retcode;
    const message = json?.message ?? "";
    if (retcode === 0)
        return { result: "success" };
    // -5003 is the documented "already checked in" retcode for the Genshin
    // sol event; the message check covers the luna events (see NOTES.md).
    if (retcode === -5003 ||
        /already|already checked|すでに|已/.test(message.toLowerCase())) {
        return { result: "already", message };
    }
    return { result: "error", message: message || `retcode ${retcode}` };
}
async function runCheckinForGame(game, state, session) {
    // Login signal comes from the session probe's retcode, never from
    // reading a cookie. On a probe transport error we still try the sign
    // call: its own response classifies any real auth problem.
    if (session.status === "not_logged_in") {
        state.runs[game.key] = {
            ...state.runs[game.key],
            checkin: {
                at: Date.now(),
                result: "not_logged_in",
                message: "HoYoLABにログインしていません",
            },
        };
        return;
    }
    try {
        const res = await fetch(game.signUrl, {
            method: "POST",
            credentials: "include",
            headers: {
                "Content-Type": "application/json",
                "x-rpc-signgame": game.signGame,
                "x-rpc-lang": "ja-jp",
            },
            body: JSON.stringify({ act_id: game.actId }),
        });
        const json = await res.json();
        const { result, message } = classifySign(json);
        state.runs[game.key] = {
            ...state.runs[game.key],
            checkin: { at: Date.now(), result, message },
        };
    }
    catch (e) {
        state.runs[game.key] = {
            ...state.runs[game.key],
            checkin: { at: Date.now(), result: "error", message: String(e) },
        };
    }
}
async function runCheckinAll() {
    const state = await loadState();
    const session = await probeSession(); // one probe shared by all games
    for (const game of GAMES) {
        if (!state.settings.games[game.key]?.checkin)
            continue;
        await runCheckinForGame(game, state, session);
        await sleep(jitter(800)); // pacing between games
    }
    state.lastCheckinRun = Date.now();
    await saveState({
        runs: state.runs,
        lastCheckinRun: state.lastCheckinRun,
    });
}
async function fetchCodes(game) {
    const json = await fetchJsonWithRetry(`${CODES_API}?game=${encodeURIComponent(game.codesGame)}`, { method: "GET" });
    const codes = json?.codes ?? [];
    return codes
        .filter((c) => c.status === "OK" && typeof c.code === "string")
        .map((c) => ({ code: c.code, rewards: c.rewards }));
}
function classifyRedeem(json) {
    const retcode = json?.retcode;
    const message = (json?.message ?? "").toLowerCase();
    if (retcode === 0)
        return "success";
    if (retcode === -1071 || retcode === -1073)
        return "auth_error";
    if (/already|使用済み|重複|已/.test(message))
        return "already_used";
    if (/expire|期限|有効期限|过期/.test(message))
        return "expired";
    if (/invalid|無効|存在しない|incorrect|not exist/.test(message))
        return "invalid";
    return "error";
}
async function redeemOne(game, role, code) {
    const params = new URLSearchParams({
        game_biz: game.gameBiz,
        region: role.region,
        uid: role.gameUid,
        cdkey: code,
        lang: "ja",
        sLangKey: "ja-jp",
    });
    const res = await fetch(`${game.redeemUrl}?${params.toString()}`, {
        method: "GET",
        credentials: "include",
    });
    const json = await res.json();
    return {
        status: classifyRedeem(json),
        retcode: json?.retcode,
        message: json?.message,
    };
}
const MAX_ERROR_TRIES = 3;
async function runCodesForGame(game, state, session) {
    const attempts = (state.attempts[game.key] ??= {});
    let codes;
    try {
        codes = await fetchCodes(game);
    }
    catch (e) {
        state.runs[game.key] = {
            ...state.runs[game.key],
            codes: { at: Date.now(), result: "error", message: `コード一覧の取得に失敗: ${e}` },
        };
        return;
    }
    state.stats.activeCounts[game.key] = codes.length;
    const pending = codes.filter(({ code }) => {
        const a = attempts[code];
        if (!a)
            return true;
        // Never re-submit finished codes; retryable errors get a capped retry.
        return a.status === "error" && a.tries < MAX_ERROR_TRIES;
    });
    if (pending.length === 0) {
        state.runs[game.key] = {
            ...state.runs[game.key],
            codes: { at: Date.now(), result: "nothing_new" },
        };
        return;
    }
    // Login signal from the session probe's retcode (ambient credentials);
    // a cookie value is never read. Probe once here if the caller did not
    // already share one for this run.
    const probe = session ?? (await probeSession());
    if (probe.status === "not_logged_in") {
        state.runs[game.key] = {
            ...state.runs[game.key],
            codes: {
                at: Date.now(),
                result: "not_logged_in",
                message: "HoYoLABにログインしていません",
            },
        };
        return;
    }
    let role;
    try {
        role = await fetchRole(game, probe);
    }
    catch (e) {
        state.runs[game.key] = {
            ...state.runs[game.key],
            codes: { at: Date.now(), result: "error", message: `アカウント情報の取得に失敗: ${e}` },
        };
        return;
    }
    if (!role) {
        state.runs[game.key] = {
            ...state.runs[game.key],
            codes: {
                at: Date.now(),
                result: "no_role",
                message: "このゲームのキャラクターが見つかりません",
            },
        };
        return;
    }
    let redeemedNow = 0;
    for (const { code } of pending) {
        const prev = attempts[code];
        try {
            const r = await redeemOne(game, role, code);
            if (r.status === "auth_error") {
                state.runs[game.key] = {
                    ...state.runs[game.key],
                    codes: {
                        at: Date.now(),
                        result: "auth_error",
                        message: "認証エラー。HoYoLABに再ログインしてください",
                    },
                };
                return; // do not burn through the remaining codes
            }
            attempts[code] = {
                status: r.status,
                at: Date.now(),
                tries: (prev?.tries ?? 0) + 1,
                retcode: r.retcode,
                message: r.message,
            };
            if (r.status === "success") {
                redeemedNow++;
                state.stats.totalRedeemed++;
            }
        }
        catch (e) {
            attempts[code] = {
                status: "error",
                at: Date.now(),
                tries: (prev?.tries ?? 0) + 1,
                message: String(e),
            };
        }
        // Persist after every code so an unload mid-run loses nothing.
        await saveState({ attempts: state.attempts, stats: state.stats });
        await sleep(jitter(4000, 0.6)); // pacing: ~2.8–5.2s between codes
    }
    state.runs[game.key] = {
        ...state.runs[game.key],
        codes: {
            at: Date.now(),
            result: "done",
            message: `${pending.length}件を試行、新規交換 ${redeemedNow}件`,
        },
    };
}
async function runCodesAll() {
    const state = await loadState();
    const session = await probeSession(); // one probe shared by all games
    for (const game of GAMES) {
        if (!state.settings.games[game.key]?.codes)
            continue;
        await runCodesForGame(game, state, session);
        await saveState({
            runs: state.runs,
            attempts: state.attempts,
            stats: state.stats,
        });
    }
    state.lastCodesRun = Date.now();
    await saveState({ lastCodesRun: state.lastCodesRun });
}
// ---------------------------------------------------------------------------
// Scheduling — listeners are registered synchronously at top level, as
// required for non-persistent background contexts.
// ---------------------------------------------------------------------------
const ALARM_CHECKIN = "daily-checkin";
const ALARM_CODES = "code-check";
const CHECKIN_HOUR = 1; // ~01:05 local, matching the Chrome original
const CHECKIN_MINUTE = 5;
function nextCheckinTime(from = new Date()) {
    const t = new Date(from);
    t.setHours(CHECKIN_HOUR, CHECKIN_MINUTE, 0, 0);
    // add up to 30 min of stable-ish spread like the original (per-day jitter)
    if (t.getTime() <= from.getTime())
        t.setDate(t.getDate() + 1);
    return t.getTime();
}
function ensureAlarms() {
    ext.alarms.get(ALARM_CHECKIN, (existing) => {
        if (!existing) {
            ext.alarms.create(ALARM_CHECKIN, {
                when: nextCheckinTime(),
                periodInMinutes: 24 * 60,
            });
        }
    });
    ext.alarms.get(ALARM_CODES, (existing) => {
        if (!existing) {
            ext.alarms.create(ALARM_CODES, {
                delayInMinutes: 5,
                periodInMinutes: 180,
            });
        }
    });
}
ensureAlarms();
ext.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_CHECKIN)
        void runCheckinAll();
    if (alarm.name === ALARM_CODES)
        void runCodesAll();
});
function localDateKey(d = new Date()) {
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
async function catchUp() {
    const state = await loadState();
    const lastDay = state.lastCheckinRun
        ? localDateKey(new Date(state.lastCheckinRun))
        : null;
    if (lastDay !== localDateKey())
        void runCheckinAll();
    void runCodesAll();
}
ext.runtime.onStartup.addListener(() => {
    ensureAlarms();
    void catchUp();
});
ext.runtime.onInstalled.addListener(() => {
    ensureAlarms();
    void catchUp();
});
// Popup messaging
ext.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "run-now") {
        const jobs = [];
        if (msg.scope === "checkin" || msg.scope === "all")
            jobs.push(runCheckinAll());
        if (msg.scope === "codes" || msg.scope === "all")
            jobs.push(runCodesAll());
        return Promise.all(jobs).then(() => ({ ok: true }));
    }
    if (msg?.type === "games") {
        return Promise.resolve({
            games: GAMES.map((g) => ({ key: g.key, label: g.label })),
        });
    }
    return undefined;
});
export {};
