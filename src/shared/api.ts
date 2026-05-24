export type InitResponse = {
  type: "init";
  postId: string;
  count: number;
  username: string;
  isModerator: boolean;
  status: 'STABLE' | 'CRISIS' | 'WAITING';
  timeSinceLastAction: number;
  lastActionTimestamp?: number;
};

export type ChecklistItem = {
  id: string;
  label: string;
  done: boolean;
  hint?: string;
};

export type DashboardData = {
  status: 'STABLE' | 'CRISIS' | 'WAITING';
  lastActionTimestamp?: number;
  isModerator: boolean;
  username: string;
  appVersion: string;
  crisisThresholdMs: number;
  brain: {
    connected: boolean;
    mode: string;
    keyHint?: string;
  };
  brainHealth: BrainHealth;
  secondOpinion: { mode: SecondOpinionMode };
  checklist: ChecklistItem[];
};

export type WeeklyReport = {
  // Inclusive period the figures cover.
  periodStart: number;
  periodEnd: number;
  approved: number;
  removed: number;
  suggested: number;
  broke: number;
  fixed: number;
  mode: string;
};

export type AppealItem = {
  postId: string;
  author: string;
  reason: string;
  createdAt: number;
  // 'removed'   — AI removed it, author hasn't appealed yet.
  // 'requested' — author replied APPEAL, awaiting a mod decision.
  // 'restored'  — post put back (manually or by AI re-review).
  // 'upheld'    — removal confirmed.
  status: 'removed' | 'requested' | 'restored' | 'upheld';
  resolution?: string;
};

export type AppealsResponse = {
  items: AppealItem[];
};

export type AppealActionResult = {
  ok: boolean;
  status?: AppealItem['status'];
  message: string;
};

export type ModVital = {
  name: string;
  vital: 'ACTIVE' | 'IDLE' | 'FLATLINE';
  lastSeenMs: number;
  actions: number;
  messagedMsAgo?: number;
};

export type TeamVitalsResponse = {
  mods: ModVital[];
};

export type Recommendation = {
  kind: 'will-message' | 'awaiting-reply' | 'suggest-demote';
  name: string;
  reason: string;
};

export type RecommendationsResponse = {
  items: Recommendation[];
};

export type ModCareResult = {
  messaged: string[];
  skipped: string[];
};

export type FindModsResult = {
  candidates: Array<{
    name: string;
    score: number;
    rationale: string;
  }>;
  note?: string;
};

// --- Second Opinion (Private Doc) ---
// Default OFF. When enabled, Dr. Mod second-opinions each removal/approval a
// present mod makes, escalating to AI only for ambiguous cases the heuristics
// can't decide.
//
// Kept intentionally separate from the AI Surrogate mode (surrogate/assistant/off):
// covering an absent mod during CRISIS is a lower trust bar than overriding a
// present mod's call, so they're two opt-ins.
export type SecondOpinionMode = 'off' | 'nurse' | 'surgeon';

export type DisputeEntry = {
  id: string;            // `${targetId}:${createdAt}`
  modName: string;
  targetId: string;      // post or comment thing id
  targetType: 'post' | 'comment';
  originalAction: 'remove' | 'approve';
  // What Dr. Mod thought should have happened (the opposite of originalAction).
  reason: string;
  // 'heuristic' = decided by local rules; 'ai' = escalated to Gemini.
  source: 'heuristic' | 'ai';
  // Surgeon mode auto-corrects; nurse mode only notifies.
  corrected: boolean;
  createdAt: number;
};

export type SecondOpinionStatus = {
  mode: SecondOpinionMode;
  // Rolling 30-day totals.
  totalDisputes: number;
  perMod: Array<{ name: string; count: number }>;
  recent: DisputeEntry[];
};

export type SaveSecondOpinionResult = {
  ok: boolean;
  mode: SecondOpinionMode;
  message: string;
};

// --- Brain Health (tier + quota) ---
// Surfaces the AI tier the dashboard is currently on:
//   'pro'     – mod pasted their own key (BYOK), unlimited.
//   'default' – using the bundled app key (limited; Crisis uncapped, others capped).
//   'local'   – no key available; heuristics-only.
export type BrainTier = 'pro' | 'default' | 'local';

export type BrainHealth = {
  tier: BrainTier;
  defaultKeyAvailable: boolean;
  // Per-feature usage on the default key today (UTC date bucket).
  usage: {
    secondOpinion: { used: number; cap: number };
    findMods: { used: number; cap: number };
  };
};

export const HEARTBEAT_KEY = "dr_mod:last_action";
// Production default. Override via the "Crisis Threshold (Hours)" setting
// or the dashboard Settings panel.
export const DEFAULT_CRISIS_THRESHOLD_MS: number = 30 * 60 * 1000; // 30 minutes

export const ApiEndpoint = {
  Init: "/api/init",
  OnDashboardMenu: "/internal/menu/post-create",
  OnAppInstall: "/internal/on-app-install",
  OnModAction: "/internal/on-mod-action",
  OnRedditPostCreate: "/internal/on-post-create",
  OnConfigure: "/internal/menu/configure",
  DashboardData: "/api/dashboard-data",
  DashboardSignal: "/api/dashboard-signal",
  TeamVitals: "/api/team-vitals",
  Recommendations: "/api/recommendations",
  RunModCare: "/api/run-mod-care",
  SaveBrain: "/api/save-brain",
  ResetBrain: "/api/reset-brain",
  FindMods: "/api/find-mods",
  WeeklyReport: "/api/weekly-report",
  Appeals: "/api/appeals",
  AppealAction: "/api/appeal-action",
  SaveSettings: "/api/save-settings",
  SecondOpinion: "/api/second-opinion",
  SaveSecondOpinion: "/api/save-second-opinion",
} as const;

export type ApiEndpoint = (typeof ApiEndpoint)[keyof typeof ApiEndpoint];

export function formatDuration(ms: number): string {
  if (ms === undefined || ms === null || isNaN(ms)) return "-- MIN";

  // Handle clock drift: if the server time is slightly ahead of client time,
  // the duration might be negative. Treat it as 0 seconds.
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));

  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (totalHours < 24) return `${totalHours}h ${minutes}m`;

  const days = Math.floor(totalHours / 24);
  const remainingHours = totalHours % 24;
  return `${days}d ${remainingHours}h`;
}
