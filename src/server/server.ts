import type { IncomingMessage, ServerResponse } from "node:http";
import { context, reddit, redis, settings } from "@devvit/web/server";
import type {
  PartialJsonValue,
  TriggerResponse,
  UiResponse,
} from "@devvit/web/shared";
import {
  ApiEndpoint,
  type InitResponse,
  type DashboardData,
  type ChecklistItem,
  type ModVital,
  type Recommendation,
  type FindModsResult,
  type WeeklyReport,
  type AppealItem,
  type AppealsResponse,
  type AppealActionResult,
  type SecondOpinionMode,
  type SecondOpinionStatus,
  type SaveSecondOpinionResult,
  type DisputeEntry,
  type BrainHealth,
  type BrainTier,
  type BurnoutMod,
  type BurnoutTier,
  type BurnoutResponse,
  HEARTBEAT_KEY,
  DEFAULT_CRISIS_THRESHOLD_MS,
  formatDuration,
} from "../shared/api.ts";
import { once } from "node:events";

export async function serverOnRequest(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  try {
    await onRequest(req, rsp);
  } catch (err) {
    const msg = `server error; ${err instanceof Error ? err.stack : err}`;
    console.error(msg);
    writeJSON<ErrorResponse>(500, { error: msg, status: 500 }, rsp);
  }
}

// Endpoints that expose or mutate moderator data — blocked for non-mods.
const MOD_ONLY_ENDPOINTS = new Set<string>([
  ApiEndpoint.DashboardData,
  ApiEndpoint.TeamVitals,
  ApiEndpoint.Recommendations,
  ApiEndpoint.RunModCare,
  ApiEndpoint.SaveBrain,
  ApiEndpoint.ResetBrain,
  ApiEndpoint.FindMods,
  ApiEndpoint.WeeklyReport,
  ApiEndpoint.Appeals,
  ApiEndpoint.AppealAction,
  ApiEndpoint.SaveSettings,
  ApiEndpoint.SecondOpinion,
  ApiEndpoint.SaveSecondOpinion,
  ApiEndpoint.Burnout,
]);

async function onRequest(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  const fullUrl = req.url || "/";
  const urlPath = fullUrl.split('?')[0]; // Strip query params for routing
  console.log(`[Incoming Request] Path: ${urlPath}`);

  if (urlPath === "/" || urlPath === "") {
    writeJSON<ErrorResponse>(404, { error: "not found", status: 404 }, rsp);
    return;
  }

  // Routed paths include both ApiEndpoint values and the /internal/* trigger,
  // menu, scheduler and form endpoints, so keep this a plain string.
  const endpoint: string = urlPath ?? "";

  // Dashboard data + actions are moderators-only. Reddit gates the menu/launcher
  // in the UI, but anyone could hit these routes directly, so enforce it here.
  if (MOD_ONLY_ENDPOINTS.has(endpoint) && !(await isCurrentUserMod())) {
    console.warn(`[DR. Mod] Blocked non-moderator access to ${endpoint} (user=${context.username ?? "—"})`);
    writeJSON<ErrorResponse>(403, { error: "moderators only", status: 403 }, rsp);
    return;
  }

  let body: any;
  switch (endpoint) {
    case ApiEndpoint.Init:
      body = await onInit();
      break;
    case ApiEndpoint.OnDashboardMenu:
      body = await onMenuDashboard();
      break;
    case ApiEndpoint.OnAppInstall:
      body = await onAppInstall();
      break;
    case ApiEndpoint.OnModAction:
      body = await onModAction(req);
      break;
    case ApiEndpoint.OnRedditPostCreate:
      body = await onRedditPostCreate(req);
      break;
    case "/internal/on-comment-create":
      body = await onCommentCreate(req);
      break;
    case "/internal/menu/headhunter":
      body = await onMenuHeadhunter();
      break;
    case "/internal/menu/probe-domains":
      body = await onMenuProbeDomains();
      break;
    case "/internal/menu/reset-brain":
      body = await onMenuResetBrain();
      break;
    case "/internal/menu/mod-care-now":
      body = await onMenuModCareNow();
      break;
    case "/internal/menu/weekly-report-now":
      body = await onMenuWeeklyReportNow();
      break;
    case "/internal/scheduled/mod-care":
      body = await onScheduledModCare();
      break;
    case "/internal/form-resolve":
      body = await onFormResolve(req);
      break;
    case ApiEndpoint.OnConfigure:
      body = { showSettingsForm: true };
      break;
    case ApiEndpoint.DashboardData:
      body = await onDashboardData();
      break;
    case ApiEndpoint.DashboardSignal:
      body = await onDashboardSignal();
      break;
    case ApiEndpoint.TeamVitals:
      body = await onTeamVitals();
      break;
    case ApiEndpoint.Recommendations:
      body = await onRecommendations();
      break;
    case ApiEndpoint.RunModCare:
      body = await onRunModCare();
      break;
    case ApiEndpoint.SaveBrain:
      body = await onSaveBrain(req);
      break;
    case ApiEndpoint.ResetBrain:
      body = await onResetBrain();
      break;
    case ApiEndpoint.FindMods:
      body = await onFindMods();
      break;
    case ApiEndpoint.WeeklyReport:
      body = await onWeeklyReport();
      break;
    case ApiEndpoint.Appeals:
      body = await onAppeals();
      break;
    case ApiEndpoint.AppealAction:
      body = await onAppealAction(req);
      break;
    case ApiEndpoint.SaveSettings:
      body = await onSaveSettings(req);
      break;
    case ApiEndpoint.SecondOpinion:
      body = await onSecondOpinionStatus();
      break;
    case ApiEndpoint.SaveSecondOpinion:
      body = await onSaveSecondOpinion(req);
      break;
    case ApiEndpoint.Burnout:
      body = await onBurnout();
      break;
    case "/internal/scheduled/weekly-report":
      body = await onScheduledWeeklyReport();
      break;
    default:
      body = { error: "not found", status: 404 };
      break;
  }

  writeJSON<PartialJsonValue>(200, body as any, rsp);
}

type ErrorResponse = {
  error: string;
  status: number;
};

// --- UTILS ---

// Reddit thing-id helpers. Payloads and Redis hand us plain strings, but the
// SDK types ids as template literals (`t1_…` comments, `t3_…` posts). These
// casts are safe: the values are genuine thing ids at runtime.
type ThingId = `t1_${string}` | `t3_${string}`;
const tid = (id: string): ThingId => id as ThingId;
const t3id = (id: string): `t3_${string}` => id as `t3_${string}`;

// Mod team membership changes infrequently. A 60s in-memory cache avoids
// hitting Reddit on every dashboard request — every tile, every poll, every
// mod-guard check used to fetch the full list.
const MOD_LIST_TTL_MS = 60 * 1000;
const modListCache = new Map<string, { usernames: string[]; expiresAt: number }>();

async function getModeratorUsernamesCached(subredditName: string): Promise<string[]> {
  const now = Date.now();
  const cached = modListCache.get(subredditName);
  if (cached && cached.expiresAt > now) return cached.usernames;
  const mods = await reddit.getModerators({ subredditName }).all();
  const usernames = mods.map((m) => m.username.toLowerCase());
  modListCache.set(subredditName, { usernames, expiresAt: now + MOD_LIST_TTL_MS });
  return usernames;
}

// Is the requesting user a moderator of this subreddit? Used to gate every
// dashboard data/action endpoint server-side — the mod-only menu and launcher
// are UI conveniences, not security.
async function isCurrentUserMod(): Promise<boolean> {
  if (!context.subredditName || !context.username) return false;
  try {
    const mods = await getModeratorUsernamesCached(context.subredditName);
    return mods.includes(context.username.toLowerCase());
  } catch (e) {
    console.warn("[DR. Mod] isCurrentUserMod check failed:", e);
    return false;
  }
}

async function getSurgicalStatus(): Promise<{ status: 'STABLE' | 'CRISIS' | 'WAITING', timeSince: number, lastActionTimestamp: number }> {
  const lastAction = await redis.get(HEARTBEAT_KEY);
  const now = Date.now();
  
  let timeSince = -1;
  let lastActionTimestamp = -1;
  if (lastAction) {
    lastActionTimestamp = Number(lastAction);
    timeSince = isNaN(lastActionTimestamp) ? -1 : now - lastActionTimestamp;
  }
  
  const override = (await settings.get<string[]>('surgical_mode'))?.[0] || 'auto';
  if (override === 'stable') return { status: 'STABLE', timeSince, lastActionTimestamp };
  if (override === 'crisis') return { status: 'CRISIS', timeSince, lastActionTimestamp };

  if (timeSince === -1) return { status: 'WAITING', timeSince, lastActionTimestamp };

  const thresholdMs = await getCrisisThresholdMs();

  return {
    status: timeSince > thresholdMs ? 'CRISIS' : 'STABLE',
    timeSince,
    lastActionTimestamp
  };
}

// How long the sub can go without a human pulse before Dr. Mod declares a
// crisis. The dashboard Settings panel writes an override to Redis (the server
// can't write subreddit settings); otherwise we read the "Crisis Threshold
// (Hours)" App Setting, then fall back to the shared default.
const CRISIS_THRESHOLD_HOURS_KEY = 'dr_mod:crisis_threshold_hours';

async function getCrisisThresholdHours(): Promise<number | undefined> {
  const fromRedis = await redis.get(CRISIS_THRESHOLD_HOURS_KEY).catch(() => null);
  if (fromRedis) {
    const n = Number(fromRedis);
    if (isFinite(n) && n > 0) return n;
  }
  const fromSettings = await settings.get<number>('crisis_threshold').catch(() => undefined);
  if (typeof fromSettings === 'number' && isFinite(fromSettings) && fromSettings > 0) return fromSettings;
  return undefined;
}

async function getCrisisThresholdMs(): Promise<number> {
  const hours = await getCrisisThresholdHours();
  return hours !== undefined ? hours * 60 * 60 * 1000 : DEFAULT_CRISIS_THRESHOLD_MS;
}

async function getBrainConfig(): Promise<{ aiKey: string | undefined; aiMode: string }> {
  // The key/mode can live in two places: the "Inject Brain" menu form
  // (stored in Redis) or the subreddit App Settings panel. Read Redis first,
  // then fall back to settings so the app works regardless of where the
  // moderator entered them.
  let aiKey = (await redis.get('dr_mod:manual_ai_key')) || undefined;
  let aiMode = (await redis.get('dr_mod:manual_ai_mode')) || undefined;

  if (!aiKey) {
    const fromSettings = await settings.get<string>('ai_api_key').catch(() => undefined);
    if (fromSettings) aiKey = fromSettings;
  }
  if (!aiMode) {
    const fromSettings = (await settings.get<string[]>('ai_mode').catch(() => undefined))?.[0];
    if (fromSettings) aiMode = fromSettings;
  }

  return { aiKey, aiMode: (aiMode || 'off').toLowerCase() };
}

// Marks a thing (post/comment id) as touched by Dr. Mod itself, so the
// resulting mod-log entry is not mistaken for a human moderator's pulse.
async function markBotAction(thingId: string): Promise<void> {
  await redis.set(`dr_mod:ai_acted:${thingId}`, "1");
  await redis.expire(`dr_mod:ai_acted:${thingId}`, 600).catch(() => {});
}

// Surrogate mode is strict: approve or remove, never filter. When the AI
// cannot reach a verdict, the safety default during a crisis is to remove.
async function surrogateReject(postId: string, reason: string, author?: string): Promise<void> {
  await markBotAction(postId);
  await reddit.remove(tid(postId), false);
  await bumpStat('removed');
  if (author) await recordAppeal(postId, author, reason);
  try {
    const notice = await reddit.submitComment({
      id: tid(postId),
      text: `**⚠️ DR. Mod: Post Removed**\n\nAI Surgeon could not verify this post during moderator downtime; surgical policy is to remove.\n\n*Reason: ${reason}*\n\n${APPEAL_INSTRUCTIONS}`,
    });
    await markBotAction(notice.id);
    await notice.distinguish(true);
  } catch (e) {
    console.warn(`[DR. Mod] Could not post removal notice for ${postId}`, e);
  }
}

// Appended to every AI-removal notice so the author knows how to appeal.
const APPEAL_INSTRUCTIONS =
  `*If you believe this was a mistake, reply to this comment with the word **APPEAL** and a human moderator will re-review it.*`;

// --- AI TIER / QUOTAS ---
// Three tiers of AI access:
//   'pro'     – the moderator pasted their own Gemini key (BYOK). No caps.
//   'default' – the app-bundled key (DR_MOD_DEFAULT_AI_KEY, baked at build).
//               Crisis surgery is uncapped (brand-promise); other features have
//               per-feature per-sub daily caps.
//   'local'   – no key available; heuristics still run, AI is skipped.
type AiTier = BrainTier;
type AiFeature = 'crisis' | 'second-opinion' | 'find-mods';

// Compile-time constant via esbuild --define in tools/build.ts. Empty = none.
function getDefaultGeminiKey(): string {
  return process.env.DR_MOD_DEFAULT_AI_KEY ?? '';
}

// Conservative per-sub daily caps for the default key. Picks assume Gemini
// Flash free tier (1,500 req/day) is shared across ~30 installs.
const AI_DAILY_CAPS: { 'second-opinion': number; 'find-mods': number } = {
  'second-opinion': 50,
  'find-mods': 0, // BYOK required — default key never used for Find Mods.
};

function aiQuotaKey(feature: AiFeature): string {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return `dr_mod:ai_quota:${feature}:${day}`;
}

async function readAiQuotaUsed(feature: AiFeature): Promise<number> {
  const raw = await redis.get(aiQuotaKey(feature)).catch(() => null);
  const n = raw ? Number(raw) : 0;
  return isNaN(n) ? 0 : n;
}

async function bumpAiQuota(feature: AiFeature): Promise<void> {
  const key = aiQuotaKey(feature);
  await redis.incrBy(key, 1).catch((e) => console.warn(`[DR. Mod] quota bump failed (${feature})`, e));
  await redis.expire(key, 36 * 60 * 60).catch(() => {});
}

// Resolve the effective key + tier for a feature. Callers can surface the tier
// in UI ("Default brain"/"Pro brain"/"Heuristics only") instead of just null.
async function getEffectiveAiKey(feature: AiFeature): Promise<{ key: string | null; tier: AiTier }> {
  const byok = (await getBrainConfig()).aiKey;
  if (byok) return { key: byok, tier: 'pro' };

  if (feature === 'find-mods') return { key: null, tier: 'local' };

  const defaultKey = getDefaultGeminiKey();
  if (!defaultKey) return { key: null, tier: 'local' };

  if (feature === 'crisis') return { key: defaultKey, tier: 'default' };

  const used = await readAiQuotaUsed(feature);
  const cap = feature === 'second-opinion' ? AI_DAILY_CAPS['second-opinion'] : AI_DAILY_CAPS['find-mods'];
  if (used >= cap) return { key: null, tier: 'local' };
  return { key: defaultKey, tier: 'default' };
}

// Tier-aware Gemini call. Bumps the per-sub quota when the default key is used
// for a capped feature; never bumps for BYOK or Crisis-uncapped paths.
async function callTieredGemini(feature: AiFeature, prompt: string, maxOutputTokens = 600): Promise<{ text: string | null; tier: AiTier }> {
  const { key, tier } = await getEffectiveAiKey(feature);
  if (!key) return { text: null, tier };
  const text = await callGemini(key, prompt, maxOutputTokens);
  if (tier === 'default' && feature !== 'crisis') {
    await bumpAiQuota(feature);
  }
  return { text, tier };
}

async function readBrainHealth(): Promise<BrainHealth> {
  const { aiKey } = await getBrainConfig();
  const defaultKey = getDefaultGeminiKey();
  const tier: BrainTier = aiKey ? 'pro' : defaultKey ? 'default' : 'local';
  const [usedSO, usedFM] = await Promise.all([
    readAiQuotaUsed('second-opinion'),
    readAiQuotaUsed('find-mods'),
  ]);
  return {
    tier,
    defaultKeyAvailable: !!defaultKey,
    usage: {
      secondOpinion: { used: usedSO, cap: AI_DAILY_CAPS['second-opinion'] },
      findMods:      { used: usedFM, cap: AI_DAILY_CAPS['find-mods'] },
    },
  };
}

// --- HEURISTIC TRIAGE ---
// Pure-code "brain" that decides obvious cases without burning an AI call.
//   agree     – the mod's call looks correct; stop.
//   disagree  – clear bad call; Second Opinion may act/notify without AI.
//   ambiguous – heuristics can't decide; caller may escalate to Gemini.

type TriageInput = {
  action: 'remove' | 'approve';
  modName: string;
  target: {
    id: string;
    type: 'post' | 'comment';
    title?: string;
    body?: string;
    authorName?: string;
    authorAccountAgeMs?: number;
    score?: number;
    numComments?: number;
    reportCount?: number;
    createdAtMs?: number;
    repliedToMod?: string;
  };
};

type TriageResult = {
  verdict: 'agree' | 'disagree' | 'ambiguous';
  reasons: string[];
};

// Short, high-confidence list. False positives here only push to "agree with
// removal," which is the safer error — we don't accuse mods for false matches.
const SLUR_PATTERNS: RegExp[] = [
  /\bn[i1]gg[ae3]r?s?\b/i,
  /\bf[a@]gg?[o0]ts?\b/i,
  /\bk[i1]kes?\b/i,
  /\bch[i1]nks?\b/i,
  /\bsp[i1]cs?\b/i,
  /\bret[a@]rd(?:s|ed)?\b/i,
  /\btr[a@]nn(?:y|ies)\b/i,
  /\bkill\s+yo?u?rself\b/i,
  /\bkys\b/i,
];

function hasSlurOrThreat(text: string | undefined): boolean {
  if (!text) return false;
  return SLUR_PATTERNS.some((re) => re.test(text));
}

const DAY_MS = 24 * 60 * 60 * 1000;

function heuristicTriage(input: TriageInput): TriageResult {
  const { action, target, modName } = input;
  const reasons: string[] = [];
  const fullText = `${target.title ?? ''}\n${target.body ?? ''}`;

  if (action === 'remove') {
    if (hasSlurOrThreat(fullText)) return { verdict: 'agree', reasons: ['contains slur/threat — removal looks correct'] };
    if (target.authorAccountAgeMs !== undefined && target.authorAccountAgeMs < DAY_MS) {
      return { verdict: 'agree', reasons: ['author account <24h old — likely spam'] };
    }
    if ((target.reportCount ?? 0) >= 5) {
      return { verdict: 'agree', reasons: [`${target.reportCount} community reports`] };
    }
    if ((target.score ?? 0) >= 50 && (target.numComments ?? 0) >= 20) {
      reasons.push(`high engagement (${target.score} score, ${target.numComments} comments) — community had endorsed it`);
      return { verdict: 'disagree', reasons };
    }
    if (target.repliedToMod && target.repliedToMod.toLowerCase() === modName.toLowerCase()) {
      return { verdict: 'disagree', reasons: ['mod removed a reply directed at themselves — possible retaliation'] };
    }
    return { verdict: 'ambiguous', reasons: ['no clear heuristic signal — escalating to AI'] };
  }

  // approve path
  if (hasSlurOrThreat(fullText)) {
    return { verdict: 'disagree', reasons: ['approved content contains slur/threat'] };
  }
  return { verdict: 'ambiguous', reasons: ['approval looks routine — AI to confirm'] };
}

// --- SECOND OPINION ---
// Off by default. When enabled, every present-mod removal/approval gets a
// heuristic + (optionally) AI second opinion.
//   Nurse:   notify-only, private modmail thread per disagreement.
//   Surgeon: auto-correct (restore wrongly-removed posts) + DM the mod.

const SO_MODE_KEY = 'dr_mod:second_opinion:mode';
const SO_DISPUTES_KEY = 'dr_mod:second_opinion:disputes';
const SO_DISPUTE_MAX = 50;
const SO_DISPUTE_TTL_SEC = 30 * 24 * 60 * 60;

const SECOND_OPINION_ACTIONS = new Set([
  'removelink', 'approvelink', 'removecomment', 'approvecomment', 'spamlink', 'spamcomment',
]);

function isRemovalAction(a: string): boolean {
  return a === 'removelink' || a === 'removecomment' || a === 'spamlink' || a === 'spamcomment';
}

async function getSecondOpinionMode(): Promise<SecondOpinionMode> {
  const raw = await redis.get(SO_MODE_KEY).catch(() => null);
  if (raw === 'nurse' || raw === 'surgeon') return raw;
  return 'off';
}

async function setSecondOpinionMode(mode: SecondOpinionMode): Promise<void> {
  await redis.set(SO_MODE_KEY, mode);
}

async function readDisputes(): Promise<DisputeEntry[]> {
  const raw = await redis.get(SO_DISPUTES_KEY).catch(() => null);
  if (!raw) return [];
  try { return JSON.parse(raw) as DisputeEntry[]; } catch { return []; }
}

async function appendDispute(entry: DisputeEntry): Promise<void> {
  const cur = await readDisputes();
  const cutoff = Date.now() - SO_DISPUTE_TTL_SEC * 1000;
  const trimmed = [entry, ...cur].filter((d) => d.createdAt >= cutoff).slice(0, SO_DISPUTE_MAX);
  await redis.set(SO_DISPUTES_KEY, JSON.stringify(trimmed));
  await redis.expire(SO_DISPUTES_KEY, SO_DISPUTE_TTL_SEC).catch(() => {});
}

async function buildSecondOpinionStatus(): Promise<SecondOpinionStatus> {
  const mode = await getSecondOpinionMode();
  const recent = await readDisputes();
  const perModMap = new Map<string, number>();
  for (const d of recent) perModMap.set(d.modName, (perModMap.get(d.modName) ?? 0) + 1);
  const perMod = [...perModMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
  return { mode, totalDisputes: recent.length, perMod, recent: recent.slice(0, 10) };
}

// Confirm the target still needs correction — bail if another mod already
// reversed it in the time our trigger took to fire + AI call to complete.
async function targetStillNeedsCorrection(postId: string, originalAction: 'remove' | 'approve'): Promise<boolean> {
  try {
    const post = await reddit.getPostById(t3id(postId));
    if (originalAction === 'remove' && !post.removed) return false;
    if (originalAction === 'approve' && post.removed) return false;
    return true;
  } catch (e) {
    console.warn(`[DR. Mod] state recheck failed for ${postId}`, e);
    return false;
  }
}

async function dmModWithFinding(modName: string, dispute: DisputeEntry, summary: string): Promise<void> {
  const verb = dispute.corrected ? 'gently reversed' : 'wants to flag';
  const noun = dispute.originalAction === 'remove' ? 'removal' : 'approval';
  try {
    await reddit.sendPrivateMessage({
      to: modName,
      subject: '🩺 Dr. Mod second opinion',
      text: `Hi u/${modName},\n\nDr. Mod ${verb} your recent ${noun} of \`${dispute.targetId}\`.\n\n**Reasoning:** ${summary}\n\nThis is a wellness check, not a strike — moderators are human and Dr. Mod is here to keep the team's calls consistent. Reply if you disagree and the team can revisit.`,
    });
  } catch (e) {
    console.warn(`[DR. Mod] DM mod ${modName} failed`, e);
  }
}

async function nurseNotify(dispute: DisputeEntry, summary: string): Promise<void> {
  const subredditName = context.subredditName;
  if (!subredditName) return;
  const body = `🩺 Second-opinion flag for u/${dispute.modName}\n\n- Target: \`${dispute.targetId}\` (${dispute.targetType})\n- Their action: ${dispute.originalAction}\n- Dr. Mod's read: ${summary}\n- Source: ${dispute.source} brain\n\nNo action taken (nurse mode — advisory only). The team can decide whether to revisit.`;
  try {
    await reddit.modMail.createConversation({
      subredditName,
      subject: `🩺 Dr. Mod second-opinion — u/${dispute.modName}`,
      body,
      to: null,
    });
  } catch (e) {
    console.warn(`[DR. Mod] nurse modmail failed for ${dispute.modName}`, e);
  }
}

async function getAccountAgeMs(username: string | undefined): Promise<number | undefined> {
  if (!username) return undefined;
  try {
    const user = await reddit.getUserByUsername(username);
    if (!user) return undefined;
    const created = (user as { createdAt?: unknown }).createdAt;
    const createdMs = created instanceof Date ? created.getTime() : Number(created);
    if (!isFinite(createdMs) || createdMs <= 0) return undefined;
    return Date.now() - createdMs;
  } catch {
    return undefined;
  }
}

async function secondOpinionAi(triage: TriageInput): Promise<{ verdict: 'agree' | 'disagree'; summary: string } | null> {
  const prompt = `You are Dr. Mod giving a second opinion on a moderator's decision. Be charitable: only DISAGREE when the call is clearly wrong (a healthy post removed, or an abusive post approved). Borderline cases should AGREE.

Moderator action: ${triage.action === 'remove' ? 'removed' : 'approved'} this ${triage.target.type}.
Title: ${triage.target.title ?? '[n/a]'}
Body: ${triage.target.body ?? '[n/a]'}

Respond EXACTLY:
VERDICT: AGREE
SUMMARY: <one short sentence>

VERDICT must be AGREE or DISAGREE on its own line.`;

  const { text, tier } = await callTieredGemini('second-opinion', prompt, 200);
  if (!text) {
    console.log(`[DR. Mod] Second Opinion AI: no key/quota (tier=${tier}). Skipping.`);
    return null;
  }
  const v = text.match(/VERDICT:\s*(AGREE|DISAGREE)/i)?.[1]?.toUpperCase();
  const summary = text.match(/SUMMARY:\s*(.+)/i)?.[1]?.trim() ?? '';
  if (v === 'DISAGREE') return { verdict: 'disagree', summary };
  return { verdict: 'agree', summary: summary || 'AI second opinion sided with the moderator.' };
}

async function surgeonCorrect(postId: string, originalAction: 'remove' | 'approve'): Promise<boolean> {
  if (!(await targetStillNeedsCorrection(postId, originalAction))) return false;
  await markBotAction(postId);
  try {
    if (originalAction === 'remove') {
      await reddit.approve(t3id(postId));
    } else {
      await reddit.remove(t3id(postId), false);
    }
    return true;
  } catch (e) {
    console.warn(`[DR. Mod] surgeonCorrect failed for ${postId}`, e);
    return false;
  }
}

async function runSecondOpinion(payload: {
  action: string;
  modName: string;
  targetId: string;
  targetType: 'post' | 'comment';
}): Promise<void> {
  const mode = await getSecondOpinionMode();
  if (mode === 'off') return;
  if (!SECOND_OPINION_ACTIONS.has(payload.action)) return;

  const originalAction: 'remove' | 'approve' = isRemovalAction(payload.action) ? 'remove' : 'approve';

  let triageInput: TriageInput;
  try {
    if (payload.targetType === 'post') {
      const post = await reddit.getPostById(t3id(payload.targetId));
      const ageMs = await getAccountAgeMs(post.authorName);
      const meta = post as unknown as { score?: number; numberOfComments?: number; createdAt?: unknown };
      const createdRaw = meta.createdAt;
      const createdMs = createdRaw instanceof Date ? createdRaw.getTime() : (typeof createdRaw === 'number' ? createdRaw : undefined);
      triageInput = {
        action: originalAction,
        modName: payload.modName,
        target: {
          id: payload.targetId,
          type: 'post',
          title: post.title,
          body: post.body || '',
          authorName: post.authorName,
          authorAccountAgeMs: ageMs,
          score: typeof meta.score === 'number' ? meta.score : undefined,
          numComments: typeof meta.numberOfComments === 'number' ? meta.numberOfComments : undefined,
          createdAtMs: createdMs,
        },
      };
    } else {
      triageInput = {
        action: originalAction,
        modName: payload.modName,
        target: { id: payload.targetId, type: 'comment' },
      };
    }
  } catch (e) {
    console.warn(`[DR. Mod] Second Opinion: failed to load ${payload.targetId}`, e);
    return;
  }

  let { verdict, reasons } = heuristicTriage(triageInput);
  let source: 'heuristic' | 'ai' = 'heuristic';

  if (verdict === 'agree') {
    console.log(`[DR. Mod] Second Opinion: agree with u/${payload.modName} on ${payload.targetId} (${reasons.join('; ')}).`);
    return;
  }

  if (verdict === 'ambiguous') {
    const ai = await secondOpinionAi(triageInput);
    if (ai === null) {
      // No AI brain available — stay quiet rather than accusing on ambiguous cases.
      console.log(`[DR. Mod] Second Opinion: ambiguous and no AI available, skipping ${payload.targetId}.`);
      return;
    }
    source = 'ai';
    verdict = ai.verdict;
    reasons = [ai.summary];
    if (verdict === 'agree') {
      console.log(`[DR. Mod] Second Opinion AI: agree with u/${payload.modName} on ${payload.targetId}.`);
      return;
    }
  }

  const summary = reasons.join('; ') || 'Dr. Mod believes this call should be re-examined.';
  const corrected = mode === 'surgeon' && payload.targetType === 'post'
    ? await surgeonCorrect(payload.targetId, originalAction)
    : false;

  const dispute: DisputeEntry = {
    id: `${payload.targetId}:${Date.now()}`,
    modName: payload.modName,
    targetId: payload.targetId,
    targetType: payload.targetType,
    originalAction,
    reason: summary,
    source,
    corrected,
    createdAt: Date.now(),
  };
  await appendDispute(dispute);

  if (mode === 'surgeon') {
    await dmModWithFinding(payload.modName, dispute, summary);
  } else {
    await nurseNotify(dispute, summary);
  }
  console.log(`[DR. Mod] Second Opinion (${mode}): disagreed with u/${payload.modName} on ${payload.targetId}. Corrected=${corrected}, source=${source}.`);
}

// --- MOD TEAM VITALS ---
// Dr. Mod cannot force an absent moderator to work, but it can diagnose which
// mods have gone quiet ("broken") - and it already covers for them via the AI
// surrogate. recordModActivity logs every genuine human mod action so the
// dashboard can show a per-moderator health chart.

// `daily` is a YYYY-MM-DD -> action-count map, pruned to the last 30 days.
// It's what powers Burnout Watch's week-over-week trend signal without
// adding any new Redis keys or a per-event log.
type ModRecord = {
  lastSeen: number;
  actions: number;
  daily?: Record<string, number>;
  messagedAt?: number;
};
type ModTeam = Record<string, ModRecord>;

const FLATLINE_MS = 7 * 24 * 60 * 60 * 1000;
const MESSAGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const DEMOTION_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;
const DAILY_RETENTION_DAYS = 30;

function dayKey(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

async function recordModActivity(modName: string, now: number): Promise<void> {
  const raw = await redis.get('dr_mod:mod_team');
  let team: ModTeam = {};
  if (raw) { try { team = JSON.parse(raw); } catch { team = {}; } }
  const rec = team[modName] || { lastSeen: 0, actions: 0 };
  rec.lastSeen = now;
  rec.actions += 1;

  const dk = dayKey(now);
  rec.daily = rec.daily || {};
  rec.daily[dk] = (rec.daily[dk] || 0) + 1;
  const cutoff = dayKey(now - DAILY_RETENTION_DAYS * DAY_MS);
  for (const k of Object.keys(rec.daily)) {
    if (k < cutoff) delete rec.daily[k];
  }

  team[modName] = rec;
  await redis.set('dr_mod:mod_team', JSON.stringify(team));
}

// Sends a modmail wellness check to every flatlined mod that hasn't been
// messaged inside the cooldown window. Stores messagedAt so the dashboard can
// escalate to a demotion suggestion if there's no response.
async function runModCarePass(): Promise<{ messaged: string[]; skipped: string[] }> {
  const raw = await redis.get('dr_mod:mod_team');
  if (!raw) return { messaged: [], skipped: [] };
  let team: ModTeam;
  try { team = JSON.parse(raw); } catch { return { messaged: [], skipped: [] }; }

  const now = Date.now();
  const subredditName = context.subredditName;
  if (!subredditName) {
    console.warn('[DR. Mod] Mod Care: no subreddit context; skipping.');
    return { messaged: [], skipped: [] };
  }

  const messaged: string[] = [];
  const skipped: string[] = [];

  for (const [name, rec] of Object.entries(team)) {
    const since = now - rec.lastSeen;
    if (since < FLATLINE_MS) continue;
    if (rec.messagedAt && (now - rec.messagedAt) < MESSAGE_COOLDOWN_MS) {
      skipped.push(name);
      continue;
    }
    const daysQuiet = Math.floor(since / (24 * 60 * 60 * 1000));
    try {
      await reddit.modMail.createConversation({
        subredditName,
        subject: `🩺 Wellness check from Dr. Mod`,
        body: `Hi u/${name},\n\nI'm Dr. Mod, your subreddit's coverage bot. I've noticed you haven't taken a mod action in **${daysQuiet} days**.\n\nNo pressure — I'm just checking in. If you're still active, take any mod action (or just reply here) and you'll be marked healthy again. If you're stepping back, your fellow mods may want to know so they can rebalance coverage.\n\nThanks for keeping this community running.`,
        to: `u/${name}`,
      });
      rec.messagedAt = now;
      team[name] = rec;
      messaged.push(name);
      console.log(`[DR. Mod] Mod Care: messaged u/${name} (${daysQuiet}d quiet).`);
    } catch (e) {
      console.warn(`[DR. Mod] Mod Care: failed to message u/${name}`, e);
    }
  }

  if (messaged.length > 0) {
    await redis.set('dr_mod:mod_team', JSON.stringify(team));
  }
  return { messaged, skipped };
}

// --- BURNOUT WATCH ---
// Companion to Mod Team Vitals. Vitals report *current* state (ACTIVE / IDLE /
// FLATLINE); Burnout predicts who is most likely to flatline next so Mod Team
// Care can reach out before the silence happens. Pure-heuristic, no AI calls,
// derived from the per-mod daily action buckets in mod_team.

function actionsInWindow(daily: Record<string, number> | undefined, now: number, startDaysAgo: number, endDaysAgo: number): number {
  if (!daily) return 0;
  // startDaysAgo is the older bound, endDaysAgo the newer (both inclusive).
  // e.g. (7, 0) = last 7 days; (14, 7) = the prior 7 days.
  const fromKey = dayKey(now - startDaysAgo * DAY_MS);
  const toKey = dayKey(now - endDaysAgo * DAY_MS);
  let total = 0;
  for (const [k, v] of Object.entries(daily)) {
    if (k >= fromKey && k <= toKey) total += v;
  }
  return total;
}

function computeBurnout(rec: ModRecord, teamLast7d: number, teamSize: number, now: number): BurnoutMod {
  const last7d = actionsInWindow(rec.daily, now, 6, 0);
  const prev7d = actionsInWindow(rec.daily, now, 13, 7);
  const daysIdle = Math.max(0, Math.floor((now - rec.lastSeen) / DAY_MS));
  const signals: string[] = [];
  let score = 0;

  // Signal 1 — idle proximity. Once a mod is more than ~3 days quiet they
  // are halfway to flatline; the score should already be flashing.
  const idleRatio = Math.min((now - rec.lastSeen) / FLATLINE_MS, 1.0);
  if (idleRatio >= 0.3) {
    score += Math.round(idleRatio * 40);
    signals.push(`Quiet for ${daysIdle}d (flatline at 7d)`);
  }

  // Signal 2 — week-over-week decline. Needs a baseline of meaningful prior
  // activity (≥5 actions) so brand-new mods don't fire it.
  if (prev7d >= 5 && last7d < prev7d * 0.5) {
    const dropPct = Math.round((1 - last7d / prev7d) * 100);
    score += 25;
    signals.push(`Actions down ${dropPct}% vs prior week (${prev7d} → ${last7d})`);
  }

  // Signal 3 — outsized workload share. If one mod is doing the work of two
  // on a team of three or more, they're a burnout candidate even when active.
  if (teamSize >= 3 && teamLast7d >= 10) {
    const share = last7d / teamLast7d;
    const expected = 1 / teamSize;
    if (share >= expected * 2.5) {
      score += 25;
      signals.push(`Carrying ${Math.round(share * 100)}% of team workload (expected ~${Math.round(expected * 100)}%)`);
    }
  }

  // Signal 4 — was busy, now silent. Caught the "I was the workhorse, then I
  // vanished" pattern that idle alone wouldn't catch yet.
  if (prev7d >= 15 && last7d <= 1 && daysIdle >= 2) {
    score += 15;
    signals.push(`Was active (${prev7d} actions last week) but suddenly quiet`);
  }

  score = Math.min(score, 100);
  const tier: BurnoutTier =
    score >= 60 ? 'at-risk' :
    score >= 30 ? 'watching' :
    'healthy';

  return {
    name: '',  // filled by caller
    score,
    tier,
    signals,
    last7d,
    prev7d,
    daysIdle,
  };
}

async function onBurnout(): Promise<BurnoutResponse> {
  const raw = await redis.get('dr_mod:mod_team').catch(() => null);
  const now = Date.now();
  if (!raw) return { mods: [], generatedAt: now };
  let team: ModTeam;
  try { team = JSON.parse(raw); } catch { return { mods: [], generatedAt: now }; }

  const entries = Object.entries(team);
  const teamSize = entries.length;
  const teamLast7d = entries.reduce((sum, [, r]) => sum + actionsInWindow(r.daily, now, 6, 0), 0);

  const mods: BurnoutMod[] = entries.map(([name, rec]) => {
    const b = computeBurnout(rec, teamLast7d, teamSize, now);
    b.name = name;
    return b;
  });

  // Highest-risk first so the dashboard's top row is the person to message.
  mods.sort((a, b) => b.score - a.score);

  return { mods, generatedAt: now };
}

// --- WEEKLY HEALTH REPORT ---
// Dr. Mod tallies the week's moderation work in plain Redis counters and PMs
// the owner a summary every Sunday. "broke"/"fixed" are derived by diffing a
// week-start snapshot of the mod team against its current state, so we don't
// need a per-mod event log.

const STAT_KEYS = {
  approved: 'dr_mod:stats:approved',   // posts the AI approved (surrogate)
  removed: 'dr_mod:stats:removed',     // posts the AI removed (surrogate)
  suggested: 'dr_mod:stats:suggested', // posts filtered for review (assistant)
} as const;
const WEEK_SNAPSHOT_KEY = 'dr_mod:week_snapshot'; // { start: number, team: Record<name, lastSeen> }

async function bumpStat(kind: keyof typeof STAT_KEYS): Promise<void> {
  await redis.incrBy(STAT_KEYS[kind], 1).catch((e) => console.warn(`[DR. Mod] stat bump failed (${kind})`, e));
}

async function readStat(kind: keyof typeof STAT_KEYS): Promise<number> {
  const raw = await redis.get(STAT_KEYS[kind]).catch(() => null);
  const n = raw ? Number(raw) : 0;
  return isNaN(n) ? 0 : n;
}

type WeekSnapshot = { start: number; team: Record<string, number> };

async function readSnapshot(): Promise<WeekSnapshot | null> {
  const raw = await redis.get(WEEK_SNAPSHOT_KEY).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw) as WeekSnapshot; } catch { return null; }
}

async function takeSnapshot(now: number): Promise<void> {
  const raw = await redis.get('dr_mod:mod_team').catch(() => null);
  let team: ModTeam = {};
  if (raw) { try { team = JSON.parse(raw); } catch { team = {}; } }
  const slim: Record<string, number> = {};
  for (const [name, rec] of Object.entries(team)) slim[name] = rec.lastSeen;
  await redis.set(WEEK_SNAPSHOT_KEY, JSON.stringify({ start: now, team: slim }));
}

// Compute broke/fixed by comparing each mod's health at snapshot time vs now.
// A mod is "healthy" if its last action was within FLATLINE_MS of the
// reference instant.
async function computeBrokeFixed(snapshot: WeekSnapshot | null, now: number): Promise<{ broke: number; fixed: number }> {
  if (!snapshot) return { broke: 0, fixed: 0 };
  const raw = await redis.get('dr_mod:mod_team').catch(() => null);
  let team: ModTeam = {};
  if (raw) { try { team = JSON.parse(raw); } catch { team = {}; } }

  let broke = 0;
  let fixed = 0;
  const names = new Set([...Object.keys(snapshot.team), ...Object.keys(team)]);
  for (const name of names) {
    const wasSeen = snapshot.team[name];
    const nowSeen = team[name]?.lastSeen;
    const wasHealthy = wasSeen !== undefined && (snapshot.start - wasSeen) <= FLATLINE_MS;
    const nowHealthy = nowSeen !== undefined && (now - nowSeen) <= FLATLINE_MS;
    if (wasHealthy && !nowHealthy) broke++;
    if (!wasHealthy && nowHealthy) fixed++;
  }
  return { broke, fixed };
}

async function buildWeeklyReport(now: number): Promise<WeeklyReport> {
  const snapshot = await readSnapshot();
  const { broke, fixed } = await computeBrokeFixed(snapshot, now);
  const { aiMode } = await getBrainConfig();
  return {
    periodStart: snapshot?.start ?? now,
    periodEnd: now,
    approved: await readStat('approved'),
    removed: await readStat('removed'),
    suggested: await readStat('suggested'),
    broke,
    fixed,
    mode: aiMode,
  };
}

function formatWeeklyReportText(r: WeeklyReport, subredditName: string): string {
  const removalLine = r.mode === 'surrogate'
    ? `🗑️ **${r.removed}** posts removed by the AI surrogate`
    : `🚩 **${r.suggested}** posts flagged to the mod queue for removal`;
  const days = Math.max(1, Math.round((r.periodEnd - r.periodStart) / (24 * 60 * 60 * 1000)));
  return `🩺 **Dr. Mod Weekly Health Report — r/${subredditName}**\n\nHere's how the last ${days} day${days === 1 ? '' : 's'} went:\n\n✅ **${r.approved}** posts approved by the AI\n${removalLine}\n💔 **${r.broke}** moderator${r.broke === 1 ? '' : 's'} went quiet (flatlined)\n❤️‍🩹 **${r.fixed}** moderator${r.fixed === 1 ? '' : 's'} recovered and came back\n\nKeep the team healthy — open the Control Room for live vitals.`;
}

async function runWeeklyReport(): Promise<WeeklyReport> {
  const now = Date.now();
  const report = await buildWeeklyReport(now);
  const subredditName = context.subredditName;
  if (subredditName) {
    try {
      await reddit.modMail.createConversation({
        subredditName,
        subject: '🩺 Dr. Mod Weekly Health Report',
        body: formatWeeklyReportText(report, subredditName),
        to: null,
      });
    } catch (e) {
      console.warn('[DR. Mod] Weekly report modmail failed', e);
    }
  }
  // Reset counters and start a fresh week.
  await Promise.all([
    redis.del(STAT_KEYS.approved),
    redis.del(STAT_KEYS.removed),
    redis.del(STAT_KEYS.suggested),
  ]).catch(() => {});
  await takeSnapshot(now);
  return report;
}

// --- USER APPEAL FLOW ---
// When the AI surrogate removes a post, we record an appeal entry. The removal
// notice invites the author to reply "APPEAL"; onCommentCreate flips the entry
// to 'requested'. Mods resolve appeals from the dashboard (manual restore/uphold
// or a second AI re-review pass).

const APPEALS_KEY = 'dr_mod:appeals'; // hash: postId -> AppealItem JSON

async function recordAppeal(postId: string, author: string, reason: string): Promise<void> {
  const item: AppealItem = { postId, author, reason, createdAt: Date.now(), status: 'removed' };
  await redis.hSet(APPEALS_KEY, { [postId]: JSON.stringify(item) }).catch((e) => console.warn('[DR. Mod] recordAppeal failed', e));
}

async function readAppeals(): Promise<AppealItem[]> {
  const map = await redis.hGetAll(APPEALS_KEY).catch(() => ({} as Record<string, string>));
  const items: AppealItem[] = [];
  for (const raw of Object.values(map || {})) {
    try { items.push(JSON.parse(raw) as AppealItem); } catch { /* skip corrupt */ }
  }
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

async function getAppeal(postId: string): Promise<AppealItem | null> {
  const raw = await redis.hGet(APPEALS_KEY, postId).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw) as AppealItem; } catch { return null; }
}

async function writeAppeal(item: AppealItem): Promise<void> {
  await redis.hSet(APPEALS_KEY, { [item.postId]: JSON.stringify(item) });
}

// --- CORE HANDLERS ---

async function onInit(): Promise<InitResponse> {
  // Default values to ensure the app NEVER crashes
  let status: 'STABLE' | 'CRISIS' | 'WAITING' = 'STABLE';
  let timeSince = 0;
  let lastActionTimestamp = Date.now();
  let isMod = false;

  console.log("[DR. Mod] Starting Init...");

  try {
    const { aiKey, aiMode } = await getBrainConfig();
    console.log(`[DR. Mod] Brain Status: ${aiKey ? 'CONNECTED' : 'DISCONNECTED'}, Mode: ${aiMode}`);

    // Attempt to get real data, but don't crash if it fails
    const health = await getSurgicalStatus().catch(e => {
      console.warn("[DR. Mod] getSurgicalStatus failed:", e);
      return null;
    });

    if (health) {
      status = health.status;
      timeSince = health.timeSince;
      lastActionTimestamp = health.lastActionTimestamp;
    }

    // Is the *viewing user* a moderator? Check membership in the actual mod
    // list — this is what gates the dashboard-open signal polling, so it must
    // be reliable, not a heuristic.
    if (context.subredditName && context.username) {
      try {
        const mods = await getModeratorUsernamesCached(context.subredditName);
        isMod = mods.includes(context.username.toLowerCase());
      } catch (e) {
        console.warn("[DR. Mod] Reddit mod check failed:", e);
        // Don't hard-fail in the dev sub — let the mod still reach the dashboard.
        isMod = context.subredditName.includes("dev");
      }
    }
  } catch (globalErr) {
    console.error("[DR. Mod] CRITICAL ERROR in onInit, falling back to defaults:", globalErr);
  }

  // Ensure lastActionTimestamp is NEVER -1 when we return
  if (lastActionTimestamp === -1) {
    lastActionTimestamp = Date.now();
  }

  const response: InitResponse = {
    type: "init",
    postId: context.postId || "unknown",
    count: 0,
    username: context.username || "user",
    isModerator: isMod,
    status: status,
    timeSinceLastAction: timeSince,
    lastActionTimestamp: lastActionTimestamp,
  };

  return response;
}

async function onAppInstall(): Promise<TriggerResponse> {
  console.log(`[DR. Mod] New Installation in r/${context.subredditName}`);

  // Initialize heartbeat immediately on install
  await redis.set(HEARTBEAT_KEY, Date.now().toString());

  // Start the first weekly-report period so broke/fixed have a baseline.
  await takeSnapshot(Date.now());

  await reddit.sendPrivateMessage({
    to: context.username || "Some_Reception_8378",
    subject: "🩺 DR. Mod: Heartbeat Monitor is live",
    text: `Welcome, Chief Surgeon. r/${context.subredditName} is now under my care.\n\nI've pinned the **Mod-Doctor Live Monitor** to the subreddit — that's the live pulse anyone can see. To open your full Control Room, click the post's three-dot menu → **DR. Mod: Dashboard** (or use the subreddit menu).`
  });

  // Pin the public-facing Live Monitor post. The Control Room dashboard pops
  // up over this post as an overlay when a mod opens it; no second post is
  // created.
  await ensureHeartbeatPost();

  return {};
}

const APP_VERSION = "v4.0.4";
const HEARTBEAT_POST_KEY = "dr_mod:heartbeat_post_id";

// Public-facing Heartbeat Monitor: one pinned post per sub. Uses the default
// devvit.json entrypoint, which renders the animated pulse view (no mod data).
async function ensureHeartbeatPost(): Promise<string> {
  const storedId = await redis.get(HEARTBEAT_POST_KEY).catch(() => null);
  if (storedId) {
    const existing = await reddit.getPostById(t3id(storedId)).catch(() => null);
    if (existing && !existing.removed) {
      return existing.url;
    }
  }
  return createHeartbeatPost();
}

async function createHeartbeatPost(): Promise<string> {
  const post = await reddit.submitCustomPost({
    title: `🩺 Mod-Doctor Live Monitor`,
  });

  try { await post.sticky(1); } catch (e) { console.warn(`[DR. Mod] Failed to sticky heartbeat post`, e); }
  try { await post.lock(); } catch (e) { console.warn(`[DR. Mod] Failed to lock heartbeat post`, e); }

  await redis.set(HEARTBEAT_POST_KEY, post.id);
  console.log(`[DR. Mod] Heartbeat post created and pinned: ${post.id}`);
  return post.url;
}

// Sets a "open dashboard" signal that the Live Monitor webview polls for.
// Scoped by subreddit so multiple subs running the app stay isolated, and so a
// missing userId in the menu context doesn't break the trigger.
const DASH_SIGNAL_TTL_SEC = 30;
function dashSignalKey(): string {
  const scope = context.subredditName || "global";
  return `dr_mod:dash_signal:${scope}`;
}

async function onMenuDashboard(): Promise<UiResponse> {
  console.log(`[DR. Mod] Dashboard menu clicked (postId=${context.postId ?? "—"} sub=${context.subredditName ?? "—"} user=${context.username ?? "—"})`);
  try {
    const aiKey = await redis.get('dr_mod:manual_ai_key');
    if (!aiKey) {
      // Brain not configured yet — keep the existing setup form flow.
      return {
        showForm: {
          name: "brainSetup",
          form: {
            title: "🩺 DR. Mod: Brain Setup",
            fields: [
              { name: "key", label: "Google Gemini API Key", type: "string", required: true },
              {
                name: "mode",
                label: "Moderation Style",
                type: "select",
                options: [
                  { label: "Surrogate (Auto-Approve)", value: "surrogate" },
                  { label: "Assistant (Recommendation)", value: "assistant" }
                ]
              }
            ],
            acceptLabel: "Inject Brain",
          },
        }
      };
    }

    // Drop the signal flag. The Live Monitor's webview polls
    // /api/dashboard-signal and slides the dashboard overlay in when it
    // sees this flag.
    const key = dashSignalKey();
    await redis.set(key, String(Date.now()));
    await redis.expire(key, DASH_SIGNAL_TTL_SEC).catch(() => {});
    console.log(`[DR. Mod] Dashboard signal set at ${key}`);

    if (context.postId) {
      // Post-level menu: user is already on a post. Don't navigate — the
      // overlay pops up over the existing view within ~1.5s.
      return { showToast: { text: "Opening dashboard…", appearance: "success" } };
    }

    // Subreddit-level menu: send them to the Live Monitor; the webview reads
    // the signal on load and opens the overlay immediately.
    const url = await ensureHeartbeatPost();
    return { navigateTo: url };
  } catch (err) {
    console.error("[DR. Mod] Dashboard Menu Error:", err);
    return {
      showToast: {
        text: "Surgical Error: Could not open dashboard. Please try again.",
        appearance: "neutral"
      }
    };
  }
}

async function onDashboardSignal(): Promise<{ open: boolean }> {
  const key = dashSignalKey();
  const flag = await redis.get(key).catch(() => null);
  if (!flag) return { open: false };
  await redis.del(key).catch(() => {});
  console.log(`[DR. Mod] Dashboard signal consumed by ${context.username ?? "anon"}`);
  return { open: true };
}

async function onFormResolve(req: IncomingMessage): Promise<UiResponse> {
  const data = await readJSON<any>(req);
  console.log("[DR. Mod] onFormResolve body:", JSON.stringify(data));
  // Devvit Web posts form values at the top level; older API nested them under .values.
  const values = (data?.values ?? data) || {};
  const key = values.key;
  const rawMode = values.mode;
  const mode = (Array.isArray(rawMode) ? rawMode[0] : rawMode) || 'surrogate';

  if (key) {
    await redis.set('dr_mod:manual_ai_key', key);
    await redis.set('dr_mod:manual_ai_mode', mode);
    console.log(`[DR. Mod] Brain injected. Mode=${mode}`);
    return { showToast: { text: "Brain injected! Dashboard is now active.", appearance: "success" } };
  }
  console.warn("[DR. Mod] Injection failed - no key in form submission");
  return { showToast: { text: "Injection failed.", appearance: "neutral" } };
}

// Synthetic platform actions Reddit fires that are NOT a human moderator
// working the queue. Counting these as a "pulse" would mask a real crisis —
// notably dev_platform_app_changed fires on every playtest redeploy.
const NON_HUMAN_MOD_ACTIONS = new Set([
  "dev_platform_app_changed",
  "dev_platform_app_installed",
  "dev_platform_app_disabled",
]);

async function onModAction(req: IncomingMessage): Promise<TriggerResponse> {
  const payload = await readJSON<any>(req).catch(() => ({}));
  const action = payload.action;

  if (NON_HUMAN_MOD_ACTIONS.has(action)) {
    console.log(`[DR. Mod] Ignoring platform action '${action}' — not a human pulse.`);
    return {};
  }

  if (action === "manual_crisis") {
    // Set heartbeat to 2 hours ago to trigger Crisis mode
    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
    await redis.set(HEARTBEAT_KEY, twoHoursAgo.toString());
    console.log("[DR. Mod] Manual CRISIS triggered");
    return {};
  }

  const now = Date.now();
  const modName = payload.moderator?.name;
  // Mod-action payloads can populate multiple target fields at once (e.g.
  // `sticky` on a comment surfaces both targetPost and targetComment). Check
  // every populated id - if any one was flagged by markBotAction, the action
  // came from us and must not be counted as a human pulse.
  const candidateIds = [payload.targetPost?.id, payload.targetComment?.id, payload.targetUser?.id].filter(Boolean);
  console.log(`[DR. Mod] onModAction debug: action=${action} modName=${modName} candidates=${candidateIds.join(',')}`);

  let matchedBotId: string | undefined;
  for (const id of candidateIds) {
    if (await redis.get(`dr_mod:ai_acted:${id}`)) {
      matchedBotId = id;
      break;
    }
  }
  if (matchedBotId) {
    await redis.del(`dr_mod:ai_acted:${matchedBotId}`);
    console.log(`[DR. Mod] Own automated action on ${matchedBotId} (${action}) - not counted as a human pulse.`);
    return {};
  }
  const targetId = candidateIds[0];

  // Genuine human moderator action: THIS is the pulse that ends a crisis.
  await redis.set(HEARTBEAT_KEY, now.toString());
  await redis.del("dr_mod:emergency_notified");
  if (modName) {
    await recordModActivity(modName, now);
    console.log(`[DR. Mod] Human pulse: u/${modName} performed ${action}. Crisis cleared.`);
  }

  if (action === "removelink" && targetId) {
    const isSafe = await redis.get(`dr_mod:post_is_safe:${targetId}`);
    if (isSafe === "true") {
      await markBotAction(targetId);
      await reddit.approve(targetId);
      await reddit.sendPrivateMessage({
        to: context.subredditName || "mod-doctor",
        subject: "🩺 MOD'S ICU: Surgical Error Detected",
        text: `Moderator u/${modName} removed a SAFE post (${targetId}). I have automatically restored it.`
      });
    }
  }

  // Second Opinion: review the call (default OFF — only runs if a mod opted in
  // from the dashboard). The trigger payload can populate both targetPost and
  // targetComment at once (e.g. sticky-on-comment), so derive the target type
  // from the action name itself — unambiguous, can't mis-classify.
  if (modName && SECOND_OPINION_ACTIONS.has(action)) {
    const isPost = action === 'removelink' || action === 'approvelink' || action === 'spamlink';
    const soTargetId = isPost ? payload.targetPost?.id : payload.targetComment?.id;
    if (soTargetId) {
      const targetType: 'post' | 'comment' = isPost ? 'post' : 'comment';
      await runSecondOpinion({ action, modName, targetId: soTargetId, targetType }).catch((e) =>
        console.warn('[DR. Mod] runSecondOpinion threw:', e)
      );
    }
  }
  return {};
}

async function onMenuHeadhunter(): Promise<UiResponse> {
  return {
    showToast: { text: "Scanning related subreddits for high-quality candidates... Report will be sent to modmail.", appearance: "success" }
  };
}

async function onMenuResetBrain(): Promise<UiResponse> {
  await redis.del('dr_mod:manual_ai_key');
  await redis.del('dr_mod:manual_ai_mode');
  console.log("[DR. Mod] Brain reset. Open the Dashboard to re-inject.");
  return {
    showToast: { text: "Brain cleared. Open the Dashboard to inject a new key.", appearance: "success" },
  };
}

async function onMenuModCareNow(): Promise<UiResponse> {
  const result = await runModCarePass();
  const text = result.messaged.length
    ? `Wellness check sent to ${result.messaged.length} flatlined mod${result.messaged.length === 1 ? '' : 's'}: ${result.messaged.map(n => 'u/' + n).join(', ')}.`
    : `No new flatlined mods to message (${result.skipped.length} still in 7-day cooldown).`;
  return { showToast: { text, appearance: 'success' } };
}

async function onScheduledModCare(): Promise<TriggerResponse> {
  const result = await runModCarePass();
  console.log(`[DR. Mod] Scheduled Mod Care: messaged=${result.messaged.length}, cooldown=${result.skipped.length}`);
  return {};
}

async function onMenuWeeklyReportNow(): Promise<UiResponse> {
  const report = await runWeeklyReport();
  return {
    showToast: {
      text: `Weekly report posted to modmail. Approved=${report.approved} Removed=${report.removed} Suggested=${report.suggested} Broke=${report.broke} Fixed=${report.fixed}.`,
      appearance: 'success',
    },
  };
}

// Each entry must also appear in devvit.json permissions.http.domains, or the
// SDK refuses the request before it leaves the sandbox. A 401/403/404/etc from
// the destination is a SUCCESS for the probe - it means the request escaped.
// Only the "is not allowed" grpc error tells us Reddit is blocking the domain.
const PROBE_DOMAINS: Array<{ host: string; path: string }> = [
  { host: 'generativelanguage.googleapis.com', path: '/v1beta/models' },
  { host: 'api.mistral.ai', path: '/v1/models' },
  { host: 'api.fireworks.ai', path: '/inference/v1/models' },
  { host: 'api.deepinfra.com', path: '/v1/openai/models' },
  { host: 'api.replicate.com', path: '/v1/models' },
  { host: 'api.x.ai', path: '/v1/models' },
  { host: 'inference.ai.azure.com', path: '/v1/models' },
  { host: 'bedrock-runtime.us-east-1.amazonaws.com', path: '/' },
  { host: 'discord.com', path: '/api/v10/users/@me' },
  { host: 'api.deepseek.com', path: '/v1/models' },
];

async function onMenuProbeDomains(): Promise<UiResponse> {
  console.log(`[DR. Mod] Probing ${PROBE_DOMAINS.length} candidate AI domains...`);
  let allowed = 0;
  let blocked = 0;
  const allowedHosts: string[] = [];
  for (const { host, path } of PROBE_DOMAINS) {
    try {
      const res = await fetch(`https://${host}${path}`, { method: 'GET' });
      console.log(`[DR. Mod] PROBE ✅ ${host} -> HTTP ${res.status}`);
      allowed++;
      allowedHosts.push(host);
    } catch (err: any) {
      const msg = (err?.details || err?.message || String(err)).slice(0, 200);
      const isSandboxBlock = /is not allowed/.test(msg);
      if (isSandboxBlock) {
        console.log(`[DR. Mod] PROBE ❌ ${host} -> sandbox blocked`);
        blocked++;
      } else {
        console.log(`[DR. Mod] PROBE ⚠️ ${host} -> ${msg}`);
        allowed++;
        allowedHosts.push(host);
      }
    }
  }
  const summary = `Probe complete: ${allowed}/${PROBE_DOMAINS.length} reachable. ${allowedHosts.join(', ') || '(none)'}`;
  console.log(`[DR. Mod] ${summary}`);
  return {
    showToast: {
      text: allowed > 0
        ? `${allowed}/${PROBE_DOMAINS.length} domains reachable. Check logs.`
        : `All ${PROBE_DOMAINS.length} domains blocked. Check logs.`,
      appearance: allowed > 0 ? 'success' : 'neutral',
    },
  };
}

async function onRedditPostCreate(req: IncomingMessage): Promise<TriggerResponse> {
  const { status } = await getSurgicalStatus();
  const payload = await readJSON<any>(req).catch(() => ({}));
  const authorName = payload.author?.name;
  const postId = payload.post?.id;

  console.log(`[DR. Mod] onRedditPostCreate: Status=${status}, Post=${postId}, Author=${authorName}`);

  if (status === 'CRISIS') {
    if (authorName && postId) {
      const { aiMode } = await getBrainConfig();
      // Crisis is uncapped on the default key — brand-promise safety net.
      // BYOK takes precedence if the mod has injected their own key.
      const { key: aiKey, tier } = await getEffectiveAiKey('crisis');
      console.log(`[DR. Mod] CRISIS: Analyzing post ${postId}...`);

      console.log(`[DR. Mod] Crisis Response: Mode=${aiMode}, HasKey=${!!aiKey}, Tier=${tier}`);

      if (aiMode !== 'off' && aiKey) {
        try {
          const post = await reddit.getPostById(postId);
          console.log(`[DR. Mod] Surgical AI: Analyzing "${post.title}"...`);

          const prompt = `You are the DR. Mod Surgical AI. Analyze this subreddit post for violations.
Criteria for REJECT:
1. Cursing or profanity directed at individuals.
2. Abuse, harassment, or bullying behavior (e.g., calling people "stupid", "idiot", or attacking the moderator).
3. Any form of hate speech.

Respond in EXACTLY this format and nothing else:
VERDICT: APPROVE
SUMMARY: <one sentence explaining the health of the post>

VERDICT must be the single word APPROVE or REJECT on its own line.

Title: ${post.title}
Body: ${post.body || '[None]'}`;

          const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(aiKey)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: 'You are a subreddit moderator assistant.' }] },
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.2, maxOutputTokens: 200 },
            })
          });

          if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            console.error(`[DR. Mod] AI API Error: ${response.status} ${response.statusText} ${errBody}`);
            if (aiMode === 'surrogate') {
              console.warn(`[DR. Mod] AI unreachable in surrogate mode - removing post ${postId} (strict policy).`);
              await surrogateReject(postId, 'AI surgeon unreachable; surrogate-mode strict policy', authorName);
            } else {
              await reddit.filter(postId, undefined, undefined);
              await bumpStat('suggested');
              console.warn(`[DR. Mod] AI unavailable - post ${postId} filtered for human review.`);
            }
            return {};
          }

          const data: any = await response.json();
          const content = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || "";
          console.log(`[DR. Mod] Surgical AI Result: ${content}`);

          // Only the explicit VERDICT line decides the outcome, so a stray
          // "approve"/"reject" word in the summary sentence cannot flip it.
          const verdictMatch = content.match(/VERDICT:\s*(APPROVE|REJECT)/i);
          // During a crisis an unparseable/unsure verdict is treated as REJECT (safety first).
          const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : 'REJECT';
          const summaryMatch = content.match(/SUMMARY:\s*(.+)/i);
          const summary = summaryMatch ? summaryMatch[1].trim() : 'Safe for community consumption.';
          if (!verdictMatch) {
            console.warn(`[DR. Mod] No clear verdict parsed - defaulting to REJECT during crisis.`);
          }

          if (verdict === 'APPROVE') {
            console.log(`[DR. Mod] Surgery: APPROVING post ${postId}`);
            await redis.set(`dr_mod:post_is_safe:${postId}`, "true");
            if (aiMode === 'surrogate') {
              await markBotAction(postId);
              await reddit.approve(postId);
              await bumpStat('approved');
              try {
                await reddit.submitComment({ id: postId, text: `**\u{1FA7A} DR. Mod: Surgical Success**\n\nAI Surgeon verified this post as healthy during moderator downtime.\n\n*Summary: ${summary}*` });
              } catch (e) { console.warn(`[DR. Mod] Could not post approval notice for ${postId}`, e); }

              // The AI does NOT restore the pulse - the crisis stays active
              // until a HUMAN moderator returns, so coverage never lapses.
              console.log(`[DR. Mod] AI handled ${postId} (Approved). Crisis remains ACTIVE until a human returns.`);
            }
          } else {
            console.log(`[DR. Mod] Surgery: REJECTING post ${postId} (Mode: ${aiMode})`);
            if (aiMode === 'surrogate') {
              // Surrogate mode: remove the abusive post directly - no filtering step.
              console.log(`[DR. Mod] Surgery: Attempting Removal of ${postId}...`);
              await markBotAction(postId);
              await reddit.remove(postId, false);
              await bumpStat('removed');
              if (authorName) await recordAppeal(postId, authorName, summary);
              try {
                const notice = await reddit.submitComment({ id: postId, text: `**\u26A0\uFE0F DR. Mod: Post Removed**\n\nAI Surgeon removed this post during moderator downtime for violating community standards.\n\n*Reason: ${summary}*\n\n${APPEAL_INSTRUCTIONS}` });
                await markBotAction(notice.id);
                await notice.distinguish(true);
              } catch (e) { console.warn(`[DR. Mod] Could not post removal notice for ${postId}`, e); }

              // The AI does NOT restore the pulse - the crisis stays active
              // until a HUMAN moderator returns, so coverage never lapses.
              console.log(`[DR. Mod] AI handled ${postId} (Removed). Crisis remains ACTIVE until a human returns.`);
            } else {
              // Assistant mode: never auto-remove - filter for priority human review.
              await reddit.filter(postId, undefined, undefined);
              await bumpStat('suggested');
              await reddit.submitComment({ id: postId, text: `**\u26A0\uFE0F DR. Mod: Quarantine Notice**\n\nAI Surgeon detected signs of infection or is unsure of post health. This post has been filtered to the Mod Queue for priority review.` });
            }
          }
        } catch (err) {
          console.error("[DR. Mod] Surgical AI Error:", err);
          if (aiMode === 'surrogate') {
            console.warn(`[DR. Mod] Surgical exception in surrogate mode - removing post ${postId} (strict policy).`);
            await surrogateReject(postId, 'AI surgeon errored mid-analysis; surrogate-mode strict policy', authorName).catch(() => {});
          } else {
            await reddit.filter(postId, undefined, undefined).catch(() => {});
            await bumpStat('suggested').catch(() => {});
          }
        }
      } else {
        if (aiMode === 'surrogate') {
          console.warn(`[DR. Mod] Surrogate mode without AI key - removing post ${postId} (strict policy).`);
          await surrogateReject(postId, 'AI key not configured; surrogate-mode strict policy', authorName);
        } else {
          await reddit.filter(postId, undefined, undefined);
          await bumpStat('suggested');
          console.warn(`[DR. Mod] AI Logic skipped (no key / mode OFF). Post ${postId} filtered for human review.`);
        }
      }
    }
  }

  // If status is WAITING, set the initial pulse to start the clock
  const lastAction = await redis.get(HEARTBEAT_KEY);
  if (!lastAction) {
    await redis.set(HEARTBEAT_KEY, Date.now().toString());
  }

  return {};
}

async function onCommentCreate(req: IncomingMessage): Promise<TriggerResponse> {
  const payload = await readJSON<any>(req).catch(() => ({}));
  const body: string = payload.comment?.body || '';
  const postId: string | undefined = payload.comment?.postId || payload.post?.id;
  const commenter: string | undefined = payload.author?.name;

  if (!postId || !commenter) return {};
  if (!/\bappeal\b/i.test(body)) return {};

  const appeal = await getAppeal(postId);
  // Only the original author of an AI-removed post can lodge an appeal, and
  // only while it's still pending.
  if (!appeal || appeal.author !== commenter || appeal.status !== 'removed') return {};

  appeal.status = 'requested';
  await writeAppeal(appeal);
  console.log(`[DR. Mod] Appeal requested by u/${commenter} for ${postId}.`);
  return {};
}

// --- DASHBOARD API HANDLERS ---

async function onDashboardData(): Promise<DashboardData> {
  const health = await getSurgicalStatus().catch(() => ({ status: 'STABLE' as const, timeSince: 0, lastActionTimestamp: Date.now() }));
  const { aiKey, aiMode } = await getBrainConfig();
  const username = context.username || '';
  // Reddit gates the mod-only menu that opens this dashboard, so anyone who
  // got here through the normal flow is at least a mod; rely on server-side
  // permission checks for the actual mutating actions.
  const isMod = true;

  const thresholdMs = await getCrisisThresholdMs();
  const thresholdSet = (await getCrisisThresholdHours()) !== undefined;
  const brainHealth = await readBrainHealth();
  const soMode = await getSecondOpinionMode();

  // With the default key baked in, "brain ready" is true whenever EITHER a
  // BYOK key is set OR the app default is available — so the checklist no
  // longer guilt-trips zero-config installs.
  const brainReady = !!aiKey || brainHealth.defaultKeyAvailable;

  const checklist: ChecklistItem[] = [
    { id: 'install', label: 'Bot installed', done: true },
    {
      id: 'brain',
      label: 'AI brain ready',
      done: brainReady,
      hint: brainReady
        ? (aiKey ? 'Pro Brain (your key) — unlimited' : 'Default Brain — works on install')
        : 'No AI available — open Inject Brain or run with heuristics only',
    },
    { id: 'threshold', label: 'Crisis threshold set', done: thresholdSet, hint: thresholdSet ? undefined : `using default: ${formatDuration(thresholdMs)}` },
    { id: 'mode', label: 'Surrogate mode confirmed', done: aiMode === 'surrogate', hint: aiMode === 'surrogate' ? undefined : `current: ${aiMode}` },
    {
      id: 'second-opinion',
      label: 'Private Doc configured',
      done: soMode !== 'off',
      hint: soMode === 'off' ? 'Optional — supervises present mods (default off)' : `mode: ${soMode}`,
    },
  ];

  return {
    status: health.status,
    lastActionTimestamp: health.lastActionTimestamp >= 0 ? health.lastActionTimestamp : undefined,
    isModerator: isMod,
    username,
    appVersion: APP_VERSION,
    crisisThresholdMs: thresholdMs,
    brain: {
      connected: brainReady,
      mode: aiMode,
      keyHint: aiKey ? `${aiKey.substring(0, 4)}…${aiKey.substring(aiKey.length - 4)}` : undefined,
    },
    brainHealth,
    secondOpinion: { mode: soMode },
    checklist,
  };
}

async function onSecondOpinionStatus(): Promise<SecondOpinionStatus> {
  return buildSecondOpinionStatus();
}

async function onSaveSecondOpinion(req: IncomingMessage): Promise<SaveSecondOpinionResult> {
  const body = await readJSON<{ mode?: string }>(req).catch(() => ({} as { mode?: string }));
  const requested = (body.mode ?? '').toLowerCase();
  const mode: SecondOpinionMode =
    requested === 'nurse' ? 'nurse' :
    requested === 'surgeon' ? 'surgeon' :
    'off';
  await setSecondOpinionMode(mode);
  const message =
    mode === 'off' ? 'Private Doc disabled.' :
    mode === 'nurse' ? 'Private Doc enabled in Nurse mode (advisory — modmail only).' :
    'Private Doc enabled in Surgeon mode (auto-corrects and DMs the mod).';
  console.log(`[DR. Mod] Second Opinion mode set to ${mode}.`);
  return { ok: true, mode, message };
}

async function onTeamVitals(): Promise<{ mods: ModVital[] }> {
  const raw = await redis.get('dr_mod:mod_team').catch(() => null);
  if (!raw) return { mods: [] };
  let team: ModTeam;
  try { team = JSON.parse(raw); } catch { return { mods: [] }; }

  const now = Date.now();
  const IDLE_MS = 24 * 60 * 60 * 1000;

  const mods: ModVital[] = Object.entries(team)
    .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
    .map(([name, rec]) => {
      const since = now - rec.lastSeen;
      const vital: ModVital['vital'] = since > FLATLINE_MS ? 'FLATLINE' : since > IDLE_MS ? 'IDLE' : 'ACTIVE';
      return {
        name,
        vital,
        lastSeenMs: since,
        actions: rec.actions,
        messagedMsAgo: rec.messagedAt ? now - rec.messagedAt : undefined,
      };
    });
  return { mods };
}

async function onRecommendations(): Promise<{ items: Recommendation[] }> {
  const raw = await redis.get('dr_mod:mod_team').catch(() => null);
  if (!raw) return { items: [] };
  let team: ModTeam;
  try { team = JSON.parse(raw); } catch { return { items: [] }; }

  const now = Date.now();
  const items: Recommendation[] = [];
  for (const [name, rec] of Object.entries(team)) {
    const since = now - rec.lastSeen;
    if (since < FLATLINE_MS) continue;
    if (rec.messagedAt && (now - rec.messagedAt) > MESSAGE_COOLDOWN_MS && since > DEMOTION_THRESHOLD_MS) {
      items.push({ kind: 'suggest-demote', name, reason: `flatlined ${formatDuration(since)}, no response to wellness check ${formatDuration(now - rec.messagedAt)} ago.` });
    } else if (!rec.messagedAt) {
      items.push({ kind: 'will-message', name, reason: `flatlined ${formatDuration(since)}. Will send wellness check on the next Mod Care pass.` });
    } else {
      items.push({ kind: 'awaiting-reply', name, reason: `wellness check sent ${formatDuration(now - rec.messagedAt)} ago, awaiting reply or any mod action.` });
    }
  }
  return { items };
}

async function onRunModCare(): Promise<{ messaged: string[]; skipped: string[] }> {
  const result = await runModCarePass();
  return result;
}

async function onSaveBrain(req: IncomingMessage): Promise<{ ok: boolean; mode?: string }> {
  const body = await readJSON<{ key?: string; mode?: string }>(req).catch(() => ({} as { key?: string; mode?: string }));
  if (!body.key) return { ok: false };
  const mode = body.mode || 'surrogate';
  await redis.set('dr_mod:manual_ai_key', body.key);
  await redis.set('dr_mod:manual_ai_mode', mode);
  console.log(`[DR. Mod] Brain saved via dashboard. Mode=${mode}`);
  return { ok: true, mode };
}

async function onResetBrain(): Promise<{ ok: boolean }> {
  await redis.del('dr_mod:manual_ai_key');
  await redis.del('dr_mod:manual_ai_mode');
  console.log('[DR. Mod] Brain cleared via dashboard.');
  return { ok: true };
}

// Minimal Gemini text call shared by Find Mods and appeal re-review. Returns
// the concatenated text of the first candidate, or null on any failure.
async function callGemini(aiKey: string, prompt: string, maxOutputTokens = 600): Promise<string | null> {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(aiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens },
      }),
    });
    if (!res.ok) {
      console.error(`[DR. Mod] Gemini error ${res.status}: ${await res.text().catch(() => '')}`);
      return null;
    }
    const data: any = await res.json();
    return data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || null;
  } catch (e) {
    console.error('[DR. Mod] Gemini call threw', e);
    return null;
  }
}

async function onFindMods(): Promise<FindModsResult> {
  // Find Mods is BYOK-only: an interactive scan is heavy on tokens, and a
  // dedicated power-user feature, so the default key never funds it.
  const { key: aiKey, tier } = await getEffectiveAiKey('find-mods');
  if (!aiKey) {
    const note = tier === 'local'
      ? 'Find Good Moderators requires your own Gemini key (Pro Brain). Open Settings → Inject Brain to add one.'
      : 'Find Good Moderators needs a Gemini key. Open Inject Brain first.';
    return { candidates: [], note };
  }
  const subredditName = context.subredditName;
  if (!subredditName) return { candidates: [], note: 'No subreddit context available.' };

  try {
    // Gather recent contributors and exclude the people who already moderate.
    const existingMods = new Set<string>();
    try {
      const mods = await getModeratorUsernamesCached(subredditName);
      for (const name of mods) existingMods.add(name);
    } catch (e) { console.warn('[DR. Mod] getModerators failed', e); }

    const posts = await reddit.getNewPosts({ subredditName, limit: 100 }).all().catch(() => []);
    const tally = new Map<string, number>();
    for (const p of posts) {
      const a = p.authorName;
      if (!a || a === '[deleted]' || a === 'AutoModerator' || existingMods.has(a.toLowerCase())) continue;
      tally.set(a, (tally.get(a) || 0) + 1);
    }

    const contributors = [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([name, count]) => `${name} (${count} recent posts)`);

    if (contributors.length === 0) {
      return { candidates: [], note: 'No eligible recent contributors found to evaluate.' };
    }

    const prompt = `You are Dr. Mod, helping a subreddit find trustworthy new moderator candidates.
From this list of recent contributors and their post counts, pick up to 5 who would make good moderators based on consistent, constructive activity.
Respond ONLY as compact JSON: an array of objects {"name": string, "score": number (0-100), "rationale": string (one short sentence)}. No markdown, no prose.

Contributors:
${contributors.join('\n')}`;

    const text = await callGemini(aiKey, prompt, 800);
    if (!text) {
      return { candidates: [], note: 'AI scan failed — check the API key and logs, then try again.' };
    }

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return { candidates: [], note: 'AI returned an unexpected format. Try the scan again.' };
    }
    const parsed = JSON.parse(jsonMatch[0]) as Array<{ name?: string; score?: number; rationale?: string }>;
    const candidates = parsed
      .filter((c) => c.name)
      .slice(0, 5)
      .map((c) => ({ name: String(c.name), score: Number(c.score) || 0, rationale: c.rationale || '' }));

    return {
      candidates,
      note: candidates.length ? `Evaluated ${contributors.length} recent contributors.` : 'No strong candidates identified this scan.',
    };
  } catch (e) {
    console.error('[DR. Mod] onFindMods failed', e);
    return { candidates: [], note: 'Scan failed — see logs.' };
  }
}

async function onWeeklyReport(): Promise<WeeklyReport> {
  return buildWeeklyReport(Date.now());
}

async function onScheduledWeeklyReport(): Promise<TriggerResponse> {
  const report = await runWeeklyReport();
  console.log(`[DR. Mod] Weekly report sent: approved=${report.approved} removed=${report.removed} suggested=${report.suggested} broke=${report.broke} fixed=${report.fixed}`);
  return {};
}

async function onAppeals(): Promise<AppealsResponse> {
  return { items: await readAppeals() };
}

async function onAppealAction(req: IncomingMessage): Promise<AppealActionResult> {
  const body = await readJSON<{ postId?: string; action?: 'restore' | 'uphold' | 'ai-rereview' }>(req).catch(() => ({} as { postId?: string; action?: string }));
  const postId = body.postId;
  const action = body.action;
  if (!postId || !action) return { ok: false, message: 'Missing postId or action.' };

  const appeal = await getAppeal(postId);
  if (!appeal) return { ok: false, message: 'Appeal not found.' };

  if (action === 'restore') {
    await markBotAction(postId);
    await reddit.approve(tid(postId)).catch((e) => console.warn('[DR. Mod] restore approve failed', e));
    appeal.status = 'restored';
    appeal.resolution = 'Manually restored by a moderator.';
    await writeAppeal(appeal);
    return { ok: true, status: appeal.status, message: `Restored post by u/${appeal.author}.` };
  }

  if (action === 'uphold') {
    appeal.status = 'upheld';
    appeal.resolution = 'Removal upheld by a moderator.';
    await writeAppeal(appeal);
    return { ok: true, status: appeal.status, message: `Removal upheld for u/${appeal.author}.` };
  }

  // ai-rereview: a second, more lenient Gemini pass on the post.
  const { aiKey } = await getBrainConfig();
  if (!aiKey) return { ok: false, message: 'AI re-review needs a Gemini key. Open Inject Brain first.' };

  let title = '';
  let postBody = '';
  try {
    const post = await reddit.getPostById(t3id(postId));
    title = post.title;
    postBody = post.body || '';
  } catch (e) {
    return { ok: false, message: 'Could not load the post to re-review.' };
  }

  const prompt = `You are Dr. Mod re-reviewing a removed post on appeal. Be fair: only uphold removal for clear hate speech, harassment, or targeted abuse. Borderline or merely opinionated content should be APPROVED.
Respond EXACTLY:
VERDICT: APPROVE
SUMMARY: <one sentence>
VERDICT must be APPROVE or REJECT on its own line.

Title: ${title}
Body: ${postBody || '[None]'}`;

  const text = await callGemini(aiKey, prompt, 200);
  if (!text) return { ok: false, message: 'AI re-review failed — see logs.' };

  const verdict = (text.match(/VERDICT:\s*(APPROVE|REJECT)/i)?.[1] || 'REJECT').toUpperCase();
  const summary = text.match(/SUMMARY:\s*(.+)/i)?.[1]?.trim() || '';

  if (verdict === 'APPROVE') {
    await markBotAction(postId);
    await reddit.approve(tid(postId)).catch((e) => console.warn('[DR. Mod] re-review approve failed', e));
    appeal.status = 'restored';
    appeal.resolution = `AI re-review approved: ${summary}`;
    await writeAppeal(appeal);
    return { ok: true, status: appeal.status, message: `AI re-review restored the post: ${summary}` };
  }
  appeal.status = 'upheld';
  appeal.resolution = `AI re-review upheld removal: ${summary}`;
  await writeAppeal(appeal);
  return { ok: true, status: appeal.status, message: `AI re-review upheld removal: ${summary}` };
}

async function onSaveSettings(req: IncomingMessage): Promise<{ ok: boolean; message: string }> {
  const body = await readJSON<{ thresholdHours?: number; mode?: string }>(req).catch(() => ({} as { thresholdHours?: number; mode?: string }));
  try {
    if (typeof body.thresholdHours === 'number' && body.thresholdHours > 0) {
      await redis.set(CRISIS_THRESHOLD_HOURS_KEY, String(body.thresholdHours));
    }
    if (body.mode) {
      await redis.set('dr_mod:manual_ai_mode', body.mode);
    }
    return { ok: true, message: 'Settings saved.' };
  } catch (e) {
    console.error('[DR. Mod] onSaveSettings failed', e);
    return { ok: false, message: 'Could not save settings.' };
  }
}

function writeJSON<T extends PartialJsonValue>(status: number, json: Readonly<T>, rsp: ServerResponse): void {
  const body = JSON.stringify(json);
  rsp.writeHead(status, { "Content-Length": Buffer.byteLength(body), "Content-Type": "application/json" });
  rsp.end(body);
}

async function readJSON<T>(req: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  await once(req, "end");
  return JSON.parse(`${Buffer.concat(chunks)}`);
}
