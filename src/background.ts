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

// Minimal WebExtension typings (avoids a @types dependency).
declare const browser: any;

const ext = (globalThis as any).browser ?? (globalThis as any).chrome;

// ---------------------------------------------------------------------------
// Game definitions (see NOTES.md for sources of every value)
// ---------------------------------------------------------------------------

interface GameDef {
  key: string;
  label: string;
  /** game id used by hoyo-codes.seria.moe (?game=) */
  codesGame: string;
  /** short biz id, e.g. "hk4e" */
  biz: string;
  /** game_biz for redemption / role lookup, e.g. "hk4e_global" */
  gameBiz: string;
  /** daily check-in sign endpoint (POST, JSON body { act_id }) */
  signUrl: string;
  actId: string;
  /** value for the x-rpc-signgame header */
  signGame: string;
  /** code redemption endpoint (GET, webExchangeCdkeyHyl variant) */
  redeemUrl: string;
}

const GAMES: GameDef[] = [
  {
    key: "genshin",
    label: "原神",
    codesGame: "genshin",
    biz: "hk4e",
    gameBiz: "hk4e_global",
    signUrl: "https://sg-hk4e-api.hoyolab.com/event/sol/sign",
    actId: "e202102251931481",
    signGame: "hk4e",
    redeemUrl:
      "https://public-operation-hk4e.hoyolab.com/common/apicdkey/api/webExchangeCdkeyHyl",
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
    redeemUrl:
      "https://public-operation-hkrpg.hoyolab.com/common/apicdkey/api/webExchangeCdkeyHyl",
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
    redeemUrl:
      "https://public-operation-nap.hoyolab.com/common/apicdkey/api/webExchangeCdkeyHyl",
  },
];

const ROLES_URL =
  "https://api-account-os.hoyolab.com/binding/api/getUserGameRolesByLtoken";
const CODES_API = "https://hoyo-codes.seria.moe/codes";

// ---------------------------------------------------------------------------
// Storage model
// ---------------------------------------------------------------------------

interface GameSettings {
  checkin: boolean;
  codes: boolean;
}
interface Settings {
  games: Record<string, GameSettings>;
}
interface GameRunStatus {
  checkin?: { at: number; result: string; message?: string };
  codes?: { at: number; result: string; message?: string };
}
type AttemptStatus =
  | "success"
  | "already_used"
  | "expired"
  | "invalid"
  | "error"; // retryable, capped
interface CodeAttempt {
  status: AttemptStatus;
  at: number;
  tries: number;
  retcode?: number;
  message?: string;
}
/** Why a run started. Threaded from every call site so the popup can show
 *  whether a run was scheduled, a catch-up, or a manual click. */
type Trigger = "alarm" | "startup" | "installed" | "manual";
type RunKind = "checkin" | "codes";
/** Single-flight lock for one run kind, kept in storage (not memory) because
 *  the background context is non-persistent. `at` is the acquisition time;
 *  locks older than LOCK_TTL_MS are treated as stale and taken over. */
interface RunLock {
  at: number;
  trigger: Trigger;
}
interface TriggerInfo {
  trigger: Trigger;
  at: number;
}
interface State {
  settings: Settings;
  runs: Record<string, GameRunStatus>;
  lastCheckinRun?: number;
  lastCodesRun?: number;
  attempts: Record<string, Record<string, CodeAttempt>>;
  stats: { totalRedeemed: number; activeCounts: Record<string, number> };
  locks: Partial<Record<RunKind, RunLock>>;
  lastTriggers: Partial<Record<RunKind, TriggerInfo>>;
}

const DEFAULT_SETTINGS: Settings = {
  games: Object.fromEntries(
    GAMES.map((g) => [g.key, { checkin: true, codes: true }]),
  ),
};

async function loadState(): Promise<State> {
  const raw = await ext.storage.local.get([
    "settings",
    "runs",
    "lastCheckinRun",
    "lastCodesRun",
    "attempts",
    "stats",
    "locks",
    "lastTriggers",
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
    locks: raw.locks ?? {},
    lastTriggers: raw.lastTriggers ?? {},
  };
}

async function saveState(patch: Partial<State>): Promise<void> {
  await ext.storage.local.set(patch);
}

// ---------------------------------------------------------------------------
// Single-flight locks (duplicate-run guard)
// ---------------------------------------------------------------------------

/** A lock older than this is assumed to belong to a crashed/unloaded run
 *  and is taken over. A full codes run takes minutes (pacing per code),
 *  so 15 minutes leaves generous headroom over a legitimate run. */
const LOCK_TTL_MS = 15 * 60 * 1000;

/** In-memory first line of defense: alarms, startup and popup messages are
 *  normally dispatched to this same background instance while it is alive,
 *  so a synchronous Set check closes the common overlap race before the
 *  async storage lock is even consulted. The storage lock below is the
 *  durable layer that survives background unloads. */
const activeRuns = new Set<RunKind>();

/** Tries to take the lock for `kind` and records the trigger. Returns false
 *  when a fresh lock is already held (caller must skip its run). A stale
 *  lock is overwritten (takeover). Storage get/set is not atomic, so two
 *  brand-new background instances racing in the same instant could both
 *  pass; the in-memory set above covers the realistic same-instance case. */
async function acquireLock(kind: RunKind, trigger: Trigger): Promise<boolean> {
  const raw = await ext.storage.local.get(["locks", "lastTriggers"]);
  const locks: Partial<Record<RunKind, RunLock>> = raw.locks ?? {};
  const now = Date.now();
  const existing = locks[kind];
  if (existing && now - existing.at < LOCK_TTL_MS) return false;
  locks[kind] = { at: now, trigger };
  const lastTriggers: Partial<Record<RunKind, TriggerInfo>> =
    raw.lastTriggers ?? {};
  lastTriggers[kind] = { trigger, at: now };
  await ext.storage.local.set({ locks, lastTriggers });
  return true;
}

async function releaseLock(kind: RunKind): Promise<void> {
  const raw = await ext.storage.local.get(["locks"]);
  const locks: Partial<Record<RunKind, RunLock>> = raw.locks ?? {};
  if (locks[kind]) {
    delete locks[kind];
    await ext.storage.local.set({ locks });
  }
}

// ---------------------------------------------------------------------------
// Helpers: jitter, backoff, fetch
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (base: number, spread = 0.5) =>
  base * (1 - spread / 2 + Math.random() * spread);

/** GET/POST JSON with exponential backoff + jitter. Used only for idempotent
 *  reads (code list, role lookup) — never for sign/redeem submissions. */
async function fetchJsonWithRetry(
  url: string,
  init: RequestInit,
  tries = 3,
): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { credentials: "include", ...init });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(jitter(1000 * 2 ** i));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Session probe / login state (ambient credentials only)
// ---------------------------------------------------------------------------

/**
 * Login detection WITHOUT reading any cookie values.
 *
 * Every API call in this file uses fetch with credentials:"include", so the
 * browser attaches the user's existing HoYoLAB login session automatically;
 * the code itself never sees any cookie value. To decide whether the user
 * is logged in,
 * we probe an authenticated endpoint (getUserGameRolesByLtoken) and look
 * only at its retcode:
 *   retcode === 0  -> logged in; the role list in the response is usable
 *   retcode !== 0  -> not logged in (or session expired)
 * A network/HTTP failure is reported as "error", distinct from
 * "not_logged_in", so callers can proceed (the sign/redeem call itself will
 * then surface any real auth problem) instead of misreporting a login state.
 */
type SessionProbe =
  | { status: "ok"; roles: any[] }
  | { status: "not_logged_in"; message?: string }
  | { status: "error"; message: string };

async function probeSession(): Promise<SessionProbe> {
  let json: any;
  try {
    json = await fetchJsonWithRetry(ROLES_URL, { method: "GET" });
  } catch (e) {
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

// ---------------------------------------------------------------------------
// Game role lookup (uid / region needed for code redemption)
// ---------------------------------------------------------------------------

interface Role {
  gameUid: string;
  region: string;
  nickname?: string;
}

/** Picks this game's role out of a session probe's role list. */
function pickRole(game: GameDef, list: any[]): Role | null {
  const mine = list.filter((r) => r.game_biz === game.gameBiz);
  if (mine.length === 0) return null;
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
async function fetchRole(
  game: GameDef,
  probe?: SessionProbe,
): Promise<Role | null> {
  const p = probe ?? (await probeSession());
  if (p.status === "error") throw new Error(p.message);
  if (p.status === "not_logged_in") return null;
  return pickRole(game, p.roles);
}

// ---------------------------------------------------------------------------
// Daily check-in
// ---------------------------------------------------------------------------

function classifySign(json: any): { result: string; message?: string } {
  const retcode = json?.retcode;
  const message: string = json?.message ?? "";
  if (retcode === 0) return { result: "success" };
  // -5003 is the documented "already checked in" retcode for the Genshin
  // sol event; the message check covers the luna events (see NOTES.md).
  if (
    retcode === -5003 ||
    /already|already checked|すでに|已/.test(message.toLowerCase())
  ) {
    return { result: "already", message };
  }
  return { result: "error", message: message || `retcode ${retcode}` };
}

async function runCheckinForGame(
  game: GameDef,
  state: State,
  session: SessionProbe,
): Promise<void> {
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
  } catch (e) {
    state.runs[game.key] = {
      ...state.runs[game.key],
      checkin: { at: Date.now(), result: "error", message: String(e) },
    };
  }
}

async function runCheckinAll(trigger: Trigger): Promise<void> {
  if (activeRuns.has("checkin")) return; // already running in this instance
  activeRuns.add("checkin");
  try {
    if (!(await acquireLock("checkin", trigger))) return; // fresh lock held
    try {
      const state = await loadState();
      const session = await probeSession(); // one probe shared by all games
      for (const game of GAMES) {
        if (!state.settings.games[game.key]?.checkin) continue;
        await runCheckinForGame(game, state, session);
        await sleep(jitter(800)); // pacing between games
      }
      state.lastCheckinRun = Date.now();
      await saveState({
        runs: state.runs,
        lastCheckinRun: state.lastCheckinRun,
      });
    } finally {
      await releaseLock("checkin");
    }
  } finally {
    activeRuns.delete("checkin");
  }
}

// ---------------------------------------------------------------------------
// Gift codes
// ---------------------------------------------------------------------------

interface CodeEntry {
  code: string;
  rewards?: string;
}

async function fetchCodes(game: GameDef): Promise<CodeEntry[]> {
  const json = await fetchJsonWithRetry(
    `${CODES_API}?game=${encodeURIComponent(game.codesGame)}`,
    { method: "GET" },
  );
  const codes: any[] = json?.codes ?? [];
  return codes
    .filter((c) => c.status === "OK" && typeof c.code === "string")
    .map((c) => ({ code: c.code, rewards: c.rewards }));
}

function classifyRedeem(json: any): AttemptStatus | "auth_error" {
  const retcode = json?.retcode;
  const message: string = (json?.message ?? "").toLowerCase();
  if (retcode === 0) return "success";
  if (retcode === -1071 || retcode === -1073) return "auth_error";
  if (/already|使用済み|重複|已/.test(message)) return "already_used";
  if (/expire|期限|有効期限|过期/.test(message)) return "expired";
  if (/invalid|無効|存在しない|incorrect|not exist/.test(message))
    return "invalid";
  return "error";
}

async function redeemOne(
  game: GameDef,
  role: Role,
  code: string,
): Promise<{ status: AttemptStatus | "auth_error"; retcode?: number; message?: string }> {
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

async function runCodesForGame(
  game: GameDef,
  state: State,
  session?: SessionProbe,
): Promise<void> {
  const attempts = (state.attempts[game.key] ??= {});
  let codes: CodeEntry[];
  try {
    codes = await fetchCodes(game);
  } catch (e) {
    state.runs[game.key] = {
      ...state.runs[game.key],
      codes: { at: Date.now(), result: "error", message: `コード一覧の取得に失敗: ${e}` },
    };
    return;
  }
  state.stats.activeCounts[game.key] = codes.length;

  const pending = codes.filter(({ code }) => {
    const a = attempts[code];
    if (!a) return true;
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

  let role: Role | null;
  try {
    role = await fetchRole(game, probe);
  } catch (e) {
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
    } catch (e) {
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

async function runCodesAll(trigger: Trigger): Promise<void> {
  if (activeRuns.has("codes")) return; // already running in this instance
  activeRuns.add("codes");
  try {
    if (!(await acquireLock("codes", trigger))) return; // fresh lock held
    try {
      const state = await loadState();
      const session = await probeSession(); // one probe shared by all games
      for (const game of GAMES) {
        if (!state.settings.games[game.key]?.codes) continue;
        await runCodesForGame(game, state, session);
        await saveState({
          runs: state.runs,
          attempts: state.attempts,
          stats: state.stats,
        });
      }
      state.lastCodesRun = Date.now();
      await saveState({ lastCodesRun: state.lastCodesRun });
    } finally {
      await releaseLock("codes");
    }
  } finally {
    activeRuns.delete("codes");
  }
}

// ---------------------------------------------------------------------------
// Scheduling — listeners are registered synchronously at top level, as
// required for non-persistent background contexts.
// ---------------------------------------------------------------------------

const ALARM_CHECKIN = "daily-checkin";
const ALARM_CODES = "code-check";
const CHECKIN_HOUR = 1; // ~01:05 local, matching the Chrome original
const CHECKIN_MINUTE = 5;

function nextCheckinTime(from = new Date()): number {
  const t = new Date(from);
  t.setHours(CHECKIN_HOUR, CHECKIN_MINUTE, 0, 0);
  // add up to 30 min of stable-ish spread like the original (per-day jitter)
  if (t.getTime() <= from.getTime()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

function ensureAlarms(): void {
  ext.alarms.get(ALARM_CHECKIN, (existing: any) => {
    if (!existing) {
      ext.alarms.create(ALARM_CHECKIN, {
        when: nextCheckinTime(),
        periodInMinutes: 24 * 60,
      });
    }
  });
  ext.alarms.get(ALARM_CODES, (existing: any) => {
    if (!existing) {
      ext.alarms.create(ALARM_CODES, {
        delayInMinutes: 5,
        periodInMinutes: 180,
      });
    }
  });
}

ensureAlarms();

ext.alarms.onAlarm.addListener((alarm: any) => {
  if (alarm.name === ALARM_CHECKIN) void runCheckinAll("alarm");
  if (alarm.name === ALARM_CODES) void runCodesAll("alarm");
});

function localDateKey(d = new Date()): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

async function catchUp(trigger: Trigger): Promise<void> {
  const state = await loadState();
  const lastDay = state.lastCheckinRun
    ? localDateKey(new Date(state.lastCheckinRun))
    : null;
  if (lastDay !== localDateKey()) void runCheckinAll(trigger);
  void runCodesAll(trigger);
}

ext.runtime.onStartup.addListener(() => {
  ensureAlarms();
  void catchUp("startup");
});

ext.runtime.onInstalled.addListener(() => {
  ensureAlarms();
  void catchUp("installed");
});

// Popup messaging
ext.runtime.onMessage.addListener((msg: any) => {
  if (msg?.type === "run-now") {
    const jobs: Promise<void>[] = [];
    if (msg.scope === "checkin" || msg.scope === "all") jobs.push(runCheckinAll("manual"));
    if (msg.scope === "codes" || msg.scope === "all") jobs.push(runCodesAll("manual"));
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
