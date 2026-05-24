import { showForm, showToast } from "@devvit/web/client";
import {
  ApiEndpoint,
  formatDuration,
  type AppealActionResult,
  type AppealItem,
  type AppealsResponse,
  type DashboardData,
  type FindModsResult,
  type ModCareResult,
  type ModVital,
  type Recommendation,
  type RecommendationsResponse,
  type SaveSecondOpinionResult,
  type SecondOpinionMode,
  type SecondOpinionStatus,
  type TeamVitalsResponse,
  type WeeklyReport,
  type BurnoutResponse,
  type SubTemperatureResponse,
} from "../shared/api.ts";

type PowerId =
  | "crisis"
  | "surrogate"
  | "second-opinion"
  | "vitals"
  | "mod-care"
  | "find-mods"
  | "appeal"
  | "report"
  | "burnout"
  | "sub-temp"
  | "settings";

type Power = {
  id: PowerId;
  icon: string;
  name: string;
  sub: string;
  needsAi: boolean;
  actionLabel: string;
};

// Order and labels mirror the approved Control Room layout.
// Second Opinion sits next to AI Surrogate — the "absent mod coverage" + "present mod supervision" pair.
const ALL_POWERS: Power[] = [
  { id: "crisis", icon: "🏥", name: "Crisis Detection", sub: "How the heartbeat & crisis work", needsAi: false, actionLabel: "View" },
  { id: "surrogate", icon: "🤖", name: "AI Surrogate", sub: "Auto-moderate during downtime", needsAi: true, actionLabel: "Open" },
  { id: "second-opinion", icon: "🧑‍⚕️", name: "Private Doc", sub: "Heuristic + AI review of present mods", needsAi: false, actionLabel: "Open" },
  { id: "vitals", icon: "🩺", name: "Mod Team Vitals", sub: "Who's healthy, who's flatlined", needsAi: false, actionLabel: "View" },
  { id: "mod-care", icon: "📬", name: "Mod Team Care", sub: "Modmail flatlined mods", needsAi: false, actionLabel: "Run Now" },
  { id: "find-mods", icon: "🎯", name: "Find Good Moderators", sub: "Scan recent contributors", needsAi: true, actionLabel: "Scan" },
  { id: "appeal", icon: "🗣️", name: "User Appeal Flow", sub: "Re-review AI removals", needsAi: true, actionLabel: "Open" },
  { id: "report", icon: "📊", name: "Weekly Health Report", sub: "7-day team summary", needsAi: false, actionLabel: "View" },
  { id: "burnout", icon: "🔥", name: "Burnout Watch", sub: "Predicts who's headed for flatline next", needsAi: false, actionLabel: "View" },
  { id: "sub-temp", icon: "🌡️", name: "Sub Temperature", sub: "Is your community running a fever?", needsAi: false, actionLabel: "Check" },
  { id: "settings", icon: "🔧", name: "Settings", sub: "Threshold, mode & brain", needsAi: false, actionLabel: "Open" },
];

let dashboardState: DashboardData | null = null;
let lastActionTimestamp = Date.now();

async function loadDashboard(): Promise<void> {
  try {
    const res = await fetch(ApiEndpoint.DashboardData);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = (await res.json()) as DashboardData;
    dashboardState = data;
    lastActionTimestamp = data.lastActionTimestamp ?? Date.now();
    renderHeader(data);
    renderChecklist(data);
    renderPowers(data);
    renderFooter(data);
  } catch (err) {
    console.error("[DR. Mod] dashboard load failed:", err);
  }
}

function renderHeader(data: DashboardData): void {
  const pill = document.getElementById("status-pill");
  if (pill) {
    pill.classList.remove("stable", "crisis", "waiting");
    pill.classList.add(data.status.toLowerCase());
    pill.textContent = data.status;
  }
  refreshHeartbeatUI();
}

function refreshHeartbeatUI(): void {
  const el = document.getElementById("heartbeat-value");
  if (!el) return;
  if (!lastActionTimestamp || lastActionTimestamp < 0) {
    el.textContent = "—";
    return;
  }
  el.textContent = `${formatDuration(Date.now() - lastActionTimestamp)} ago`;
}

function renderChecklist(data: DashboardData): void {
  const list = document.getElementById("checklist");
  if (!list) return;
  const setupCard = document.getElementById("setup-card");
  const allDone = data.checklist.every((c) => c.done);
  if (allDone && setupCard) {
    setupCard.classList.add("hidden");
    return;
  }
  if (setupCard) setupCard.classList.remove("hidden");

  list.innerHTML = data.checklist
    .map((c) => `
      <li>
        <span class="cr-check-icon ${c.done ? "done" : "pending"}">${c.done ? "✓" : ""}</span>
        <span class="cr-check-label ${c.done ? "done" : ""}">${escapeHtml(c.label)}</span>
        ${c.hint ? `<span class="cr-check-hint">${escapeHtml(c.hint)}</span>` : ""}
      </li>
    `)
    .join("");
}

function renderPowers(data: DashboardData): void {
  const list = document.getElementById("powers-list");
  if (!list) return;

  // AI powers stay visible and clickable even with no key — clicking one when
  // disconnected just nudges the moderator to inject a key first.
  list.innerHTML = ALL_POWERS
    .map((p) => {
      const locked = p.needsAi && !data.brain.connected;
      const tag = p.needsAi
        ? `<span class="cr-power-tag ai">${locked ? "needs key" : "AI"}</span>`
        : `<span class="cr-power-tag free">AI-free</span>`;
      const style = p.id === "settings" ? "secondary" : "";
      return `
        <li>
          <span class="cr-power-icon">${p.icon}</span>
          <span class="cr-power-text">
            <div class="cr-power-name">${escapeHtml(p.name)}</div>
            <div class="cr-power-sub">${escapeHtml(p.sub)}</div>
          </span>
          ${tag}
          <button class="cr-action ${style}" data-power="${p.id}">${escapeHtml(p.actionLabel)}</button>
        </li>
      `;
    })
    .join("");

  list.querySelectorAll<HTMLButtonElement>("button[data-power]").forEach((btn) => {
    btn.addEventListener("click", () => handlePower(btn.dataset.power as PowerId, btn));
  });
}

function renderFooter(data: DashboardData): void {
  const v = document.getElementById("footer-version");
  const u = document.getElementById("footer-user");
  if (v) v.textContent = `DR. MOD ${data.appVersion}`;
  if (u) u.textContent = data.username ? `u/${data.username}` : "—";
}

function openDetail(title: string, body: string): void {
  openDetailHtml(title, `<div class="cr-detail-text">${escapeHtml(body)}</div>`);
}

function openDetailHtml(title: string, html: string): void {
  const panel = document.getElementById("detail-panel");
  const t = document.getElementById("detail-title");
  const b = document.getElementById("detail-body");
  if (!panel || !t || !b) return;
  t.textContent = title;
  b.innerHTML = html;
  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function handlePower(id: PowerId, btn: HTMLButtonElement): Promise<void> {
  const power = ALL_POWERS.find((p) => p.id === id);
  // Gating: an AI power with no key injected explains itself instead of running.
  if (power?.needsAi && !dashboardState?.brain.connected) {
    showToast("To use this power, inject an API key first via Settings → Inject Brain.");
    return;
  }

  const original = btn.textContent || "";
  btn.disabled = true;
  btn.textContent = "…";
  try {
    switch (id) {
      case "crisis": runCrisis(); break;
      case "surrogate": runSurrogate(); break;
      case "second-opinion": await runSecondOpinion(); break;
      case "vitals": await runVitals(); break;
      case "mod-care": await runModCare(); break;
      case "find-mods": await runFindMods(); break;
      case "appeal": await runAppeals(); break;
      case "report": await runReport(); break;
      case "burnout": await runBurnout(); break;
      case "sub-temp": await runSubTemperature(); break;
      case "settings": runSettings(); break;
    }
  } catch (err) {
    console.error(`[DR. Mod] power ${id} failed:`, err);
    showToast(`Power "${id}" failed — see logs.`);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// --- Crisis Detection (info) ---
function runCrisis(): void {
  const d = dashboardState;
  const status = d?.status ?? "—";
  const threshold = d ? formatDuration(d.crisisThresholdMs) : "—";
  const lastPulse = lastActionTimestamp > 0 ? `${formatDuration(Date.now() - lastActionTimestamp)} ago` : "—";
  openDetailHtml("Crisis Detection", `
    <div class="cr-stat-grid">
      <div class="cr-stat"><span class="cr-stat-num status-${(d?.status ?? "").toLowerCase()}">${escapeHtml(status)}</span><span class="cr-stat-cap">Current status</span></div>
      <div class="cr-stat"><span class="cr-stat-num">${escapeHtml(threshold)}</span><span class="cr-stat-cap">Crisis threshold</span></div>
      <div class="cr-stat"><span class="cr-stat-num">${escapeHtml(lastPulse)}</span><span class="cr-stat-cap">Last human pulse</span></div>
    </div>
    <div class="cr-detail-text">Every human moderator action is a "pulse." If no moderator acts within the crisis threshold, the sub flatlines into <b>CRISIS</b> and the AI surrogate (if enabled) covers new posts until a human returns. Adjust the threshold in <b>Settings</b>.</div>
  `);
}

// --- AI Surrogate (info) ---
function runSurrogate(): void {
  const mode = dashboardState?.brain.mode ?? "off";
  const connected = dashboardState?.brain.connected;
  const modeLine = mode === "surrogate"
    ? "🤖 <b>Surrogate</b> — during a crisis the AI approves healthy posts and removes violations automatically."
    : mode === "assistant"
    ? "🩺 <b>Assistant</b> — during a crisis the AI filters suspect posts to the mod queue (never auto-removes)."
    : "⚪ <b>Off</b> — the AI takes no action.";
  openDetailHtml("AI Surrogate", `
    <div class="cr-detail-text">Brain: <b>${connected ? "connected" : "not connected"}</b><br/>Mode: ${modeLine}<br/><br/>Switch modes in <b>Settings</b>. The AI never restores the human pulse — a crisis only ends when a real moderator acts.</div>
  `);
}

// --- Mod Team Vitals ---
async function runVitals(): Promise<void> {
  const res = await fetch(ApiEndpoint.TeamVitals);
  const data = (await res.json()) as TeamVitalsResponse;
  if (!data.mods?.length) {
    openDetail("Mod Team Vitals", "No moderator activity recorded yet.");
    return;
  }
  openDetailHtml("Mod Team Vitals", data.mods.map(vitalRow).join(""));
}

function vitalRow(m: ModVital): string {
  const dot = m.vital === "ACTIVE" ? "🟢" : m.vital === "IDLE" ? "🟡" : "🔴";
  const checkIn = typeof m.messagedMsAgo === "number" ? ` · checked-in ${formatDuration(m.messagedMsAgo)} ago` : "";
  return `<div class="row">${dot} <b>u/${escapeHtml(m.name)}</b> — last action ${formatDuration(m.lastSeenMs)} ago · ${m.actions} total${escapeHtml(checkIn)}</div>`;
}

// --- Burnout Watch ---
// Vitals tells you who's flatlined; Burnout tells you who's headed there next.
async function runBurnout(): Promise<void> {
  const res = await fetch(ApiEndpoint.Burnout);
  const data = (await res.json()) as BurnoutResponse;
  const intro = `<div class="cr-detail-text">
    Burnout predicts which moderators are most likely to flatline next so Mod Team Care can reach out before the silence happens. Pure heuristics over the last 30 days of activity — no AI needed.
  </div>`;
  if (!data.mods.length) {
    openDetailHtml("Burnout Watch", intro + `<div class="row cr-muted">No moderator activity recorded yet.</div>`);
    return;
  }
  const rows = data.mods.map(burnoutRow).join("");
  openDetailHtml("Burnout Watch", intro + rows);
}

function burnoutRow(m: { name: string; score: number; tier: 'healthy' | 'watching' | 'at-risk'; signals: string[]; last7d: number; prev7d: number; daysIdle: number }): string {
  const dot = m.tier === 'healthy' ? '🟢' : m.tier === 'watching' ? '🟡' : '🔴';
  const tierLabel = m.tier === 'at-risk' ? 'AT RISK' : m.tier === 'watching' ? 'Watching' : 'Healthy';
  const signals = m.signals.length
    ? `<br/><span class="cr-muted">${m.signals.map(escapeHtml).join(' · ')}</span>`
    : `<br/><span class="cr-muted">No risk signals — activity looks sustainable.</span>`;
  return `<div class="row">
    ${dot} <b>u/${escapeHtml(m.name)}</b> — ${tierLabel} (score ${m.score})
    <br/><span class="cr-muted">Last 7d: ${m.last7d} actions · Prior 7d: ${m.prev7d} · Idle ${m.daysIdle}d</span>
    ${signals}
  </div>`;
}

// --- Sub Temperature ---
// Watches the community itself: every new post and comment gets a fast
// heuristic toxicity score and the dashboard reports the 7-day reading.
async function runSubTemperature(): Promise<void> {
  const res = await fetch(ApiEndpoint.SubTemperature);
  const data = (await res.json()) as SubTemperatureResponse;

  const tierEmoji =
    data.tier === 'normal' ? '✅' :
    data.tier === 'warm' ? '🟡' :
    data.tier === 'elevated' ? '🟠' :
    data.tier === 'fever' ? '🔴' : '🚨';
  const tierLabel =
    data.tier === 'normal' ? 'Normal' :
    data.tier === 'warm' ? 'Slightly Warm' :
    data.tier === 'elevated' ? 'Elevated' :
    data.tier === 'fever' ? 'Fever' : 'HIGH FEVER';
  const trendArrow = data.trend === 'rising' ? '↗' : data.trend === 'falling' ? '↘' : '→';

  const intro = `<div class="cr-detail-text">
    Sub Temperature measures the <b>community</b>'s mood, not the moderators'. Every new post and comment gets a fast heuristic toxicity score (0–10) and we report the rolling 7-day reading. Pure heuristic — no AI calls, no quota cost.
  </div>`;

  const reading = `<div class="row" style="font-size:1.1em">
    <b>${tierEmoji} ${data.tempF}°F — ${tierLabel}</b> ${trendArrow} (avg score ${data.avgScore} / 10)
    <br/><span class="cr-muted">${data.totalSamples} samples over last 7 days · trend ${escapeHtml(data.trend)}</span>
  </div>`;

  const reco = `<div class="row"><b>🩺 Recommendation:</b> ${escapeHtml(data.recommendation)}</div>`;

  const sparkline = data.last7d.map((d) => {
    // Bar height scales 0-10 to 6-30px so 0-sample days still show a tiny tick.
    const h = d.samples > 0 ? Math.max(6, Math.round(d.avgScore * 3)) : 3;
    const color = d.avgScore < 1 ? '#3aa869' : d.avgScore < 3 ? '#d6b21a' : d.avgScore < 5 ? '#e07b1a' : d.avgScore < 7 ? '#d23f3f' : '#9a0e0e';
    const label = `${escapeHtml(d.day.slice(5))} · ${d.samples > 0 ? `${d.avgScore.toFixed(1)} (${d.samples})` : 'no data'}`;
    return `<div style="display:inline-block;width:34px;text-align:center;vertical-align:bottom;margin-right:2px">
      <div style="height:${h}px;background:${color};margin:0 auto;width:14px;border-radius:2px"></div>
      <div class="cr-muted" style="font-size:.75em;margin-top:2px">${label}</div>
    </div>`;
  }).join('');

  const history = `<div class="row"><b>Last 7 days:</b><br/>${sparkline}</div>`;

  openDetailHtml("Sub Temperature", intro + reading + reco + history);
}

// --- Mod Team Care: run the pass, then show what's pending ---
async function runModCare(): Promise<void> {
  const res = await fetch(ApiEndpoint.RunModCare, { method: "POST" });
  const data = (await res.json()) as ModCareResult;
  if (data.messaged.length) {
    showToast(`Messaged ${data.messaged.length} mod${data.messaged.length === 1 ? "" : "s"}.`);
  } else {
    showToast(`No new flatlined mods (${data.skipped.length} in cooldown).`);
  }
  const recRes = await fetch(ApiEndpoint.Recommendations);
  const recs = (await recRes.json()) as RecommendationsResponse;
  const sent = data.messaged.length
    ? `<div class="row">📬 Just messaged: ${data.messaged.map((n) => "u/" + escapeHtml(n)).join(", ")}</div>`
    : "";
  const body = recs.items?.length ? recs.items.map(recRow).join("") : `<div class="row">All mods are healthy — no actions needed.</div>`;
  openDetailHtml("Mod Team Care", sent + body);
  await loadDashboard();
}

function recRow(r: Recommendation): string {
  const icon = r.kind === "will-message" ? "📬" : r.kind === "awaiting-reply" ? "⏳" : "🪦";
  return `<div class="row">${icon} <b>u/${escapeHtml(r.name)}</b> — ${escapeHtml(r.reason)}</div>`;
}

// --- Find Good Moderators ---
async function runFindMods(): Promise<void> {
  openDetail("Find Good Moderators", "Scanning recent contributors…");
  const res = await fetch(ApiEndpoint.FindMods, { method: "POST" });
  const data = (await res.json()) as FindModsResult;
  if (!data.candidates?.length) {
    openDetail("Find Good Moderators", data.note || "No candidates found.");
    return;
  }
  const rows = data.candidates
    .map((c) => `<div class="row">🎯 <b>u/${escapeHtml(c.name)}</b> · score ${c.score}<br/><span class="cr-muted">${escapeHtml(c.rationale)}</span></div>`)
    .join("");
  const note = data.note ? `<div class="row cr-muted">${escapeHtml(data.note)}</div>` : "";
  openDetailHtml("Find Good Moderators", rows + note);
}

// --- User Appeal Flow ---
async function runAppeals(): Promise<void> {
  const res = await fetch(ApiEndpoint.Appeals);
  const data = (await res.json()) as AppealsResponse;
  if (!data.items?.length) {
    openDetail("User Appeal Flow", "No appeals yet. When the AI surrogate removes a post, the author can reply APPEAL and it shows up here for re-review.");
    return;
  }
  renderAppeals(data.items);
}

function renderAppeals(items: AppealItem[]): void {
  const rows = items.map((a) => {
    const badge = a.status === "requested" ? "🟠 appeal requested"
      : a.status === "restored" ? "🟢 restored"
      : a.status === "upheld" ? "⚪ upheld"
      : "🔴 removed";
    const pending = a.status === "removed" || a.status === "requested";
    const actions = pending
      ? `<div class="cr-appeal-actions">
           <button class="cr-mini" data-appeal="${a.postId}" data-act="ai-rereview">Re-review (AI)</button>
           <button class="cr-mini" data-appeal="${a.postId}" data-act="restore">Restore</button>
           <button class="cr-mini warn" data-appeal="${a.postId}" data-act="uphold">Uphold</button>
         </div>`
      : `<div class="cr-muted">${escapeHtml(a.resolution || "")}</div>`;
    return `<div class="row cr-appeal">
        <div><b>u/${escapeHtml(a.author)}</b> · ${badge}</div>
        <div class="cr-muted">${escapeHtml(a.reason)}</div>
        ${actions}
      </div>`;
  }).join("");
  openDetailHtml("User Appeal Flow", rows);

  document.querySelectorAll<HTMLButtonElement>("#detail-body button[data-appeal]").forEach((btn) => {
    btn.addEventListener("click", () => resolveAppeal(btn.dataset.appeal!, btn.dataset.act as "ai-rereview" | "restore" | "uphold"));
  });
}

async function resolveAppeal(postId: string, action: "ai-rereview" | "restore" | "uphold"): Promise<void> {
  const res = await fetch(ApiEndpoint.AppealAction, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postId, action }),
  });
  const data = (await res.json()) as AppealActionResult;
  showToast(data.message);
  await runAppeals(); // refresh the list
}

// --- Weekly Health Report ---
async function runReport(): Promise<void> {
  const res = await fetch(ApiEndpoint.WeeklyReport);
  const r = (await res.json()) as WeeklyReport;
  const days = Math.max(1, Math.round((r.periodEnd - r.periodStart) / (24 * 60 * 60 * 1000)));
  const removalStat = r.mode === "surrogate"
    ? { num: r.removed, cap: "Removed by AI" }
    : { num: r.suggested, cap: "Flagged for removal" };
  openDetailHtml("Weekly Health Report", `
    <div class="cr-detail-text cr-muted">Running tally for the last ${days} day${days === 1 ? "" : "s"} (${r.mode} mode):</div>
    <div class="cr-stat-grid">
      <div class="cr-stat"><span class="cr-stat-num">${r.approved}</span><span class="cr-stat-cap">Approved by AI</span></div>
      <div class="cr-stat"><span class="cr-stat-num">${removalStat.num}</span><span class="cr-stat-cap">${removalStat.cap}</span></div>
      <div class="cr-stat"><span class="cr-stat-num">${r.broke}</span><span class="cr-stat-cap">Mods flatlined</span></div>
      <div class="cr-stat"><span class="cr-stat-num">${r.fixed}</span><span class="cr-stat-cap">Mods recovered</span></div>
    </div>
    <div class="cr-detail-text cr-muted">A full report is also modmailed to the team every week.</div>
  `);
}

// --- Settings (threshold, mode, brain) ---
function runSettings(): void {
  const d = dashboardState;
  const threshold = d ? formatDuration(d.crisisThresholdMs) : "—";
  const mode = d?.brain.mode ?? "off";
  const byok = !!d?.brain.keyHint;
  const keyHint = d?.brain.keyHint ? ` (${d.brain.keyHint})` : "";
  const tier = d?.brainHealth?.tier ?? "local";
  const tierLine = renderTierLine(d);
  openDetailHtml("Settings", `
    <div class="cr-detail-text">
      Crisis threshold: <b>${escapeHtml(threshold)}</b><br/>
      Moderation mode: <b>${escapeHtml(mode)}</b><br/>
      ${tierLine}
    </div>
    <div class="cr-appeal-actions">
      <button class="cr-mini" id="set-edit">Edit threshold & mode</button>
      <button class="cr-mini" id="set-brain">${byok ? "Replace key" : (tier === "default" ? "Upgrade to Pro Brain" : "Inject Brain")}</button>
      ${byok ? `<button class="cr-mini warn" id="set-reset">Remove key${escapeHtml(keyHint)}</button>` : ""}
    </div>
  `);
  document.getElementById("set-edit")?.addEventListener("click", editSettings);
  document.getElementById("set-brain")?.addEventListener("click", injectBrain);
  document.getElementById("set-reset")?.addEventListener("click", resetBrain);
}

// Tier framing surfaced in Settings + Second Opinion details. "Pro" = the mod
// pasted their own key; "Default" = bundled app key (capped); "Local" = no AI.
function renderTierLine(d: DashboardData | null): string {
  if (!d) return "AI brain: <b>—</b>";
  const h = d.brainHealth;
  const tierLabel = h.tier === "pro" ? "Pro Brain (your key — unlimited)"
    : h.tier === "default" ? "Default Brain (built-in — limited)"
    : "Local Brain (heuristics only)";
  const usageBlock = h.tier === "default" ? `<br/><span class="cr-muted">Private Doc AI today: ${h.usage.secondOpinion.used}/${h.usage.secondOpinion.cap} · Crisis surgery: uncapped</span>` : "";
  return `AI brain: <b>${escapeHtml(tierLabel)}</b>${usageBlock}`;
}

// --- Second Opinion (heuristics + AI review of present mods) ---
async function runSecondOpinion(): Promise<void> {
  const res = await fetch(ApiEndpoint.SecondOpinion);
  const status = (await res.json()) as SecondOpinionStatus;
  renderSecondOpinion(status);
}

function renderSecondOpinion(status: SecondOpinionStatus): void {
  const d = dashboardState;
  const tierLine = renderTierLine(d);
  const modeLabel = status.mode === "off" ? "⚪ Off — Dr. Mod is not reviewing mod calls"
    : status.mode === "nurse" ? "🩺 Nurse — advisory only; flags via modmail thread"
    : "🔪 Surgeon — auto-corrects clear bad calls + DMs the mod";

  const intro = `<div class="cr-detail-text">
    Private Doc supervises <b>present</b> moderators (Surrogate covers <b>absent</b> ones). Every removal or approval is reviewed by Dr. Mod's heuristics first; ambiguous cases escalate to AI if available.
    <br/><br/>${tierLine}
    <br/><br/>Current mode: <b>${escapeHtml(modeLabel)}</b>
  </div>`;

  const buttons = `<div class="cr-appeal-actions">
    <button class="cr-mini" data-so="off">Turn off</button>
    <button class="cr-mini" data-so="nurse">Set to Nurse</button>
    <button class="cr-mini warn" data-so="surgeon">Set to Surgeon</button>
  </div>`;

  const disputeBlock = status.recent.length === 0
    ? `<div class="row cr-muted">No flagged calls in the last 30 days.</div>`
    : status.recent.map((d) => {
        const when = formatDuration(Date.now() - d.createdAt);
        const verb = d.corrected ? "↩️ corrected" : "🚩 flagged";
        const src = d.source === "ai" ? "AI brain" : "heuristics";
        return `<div class="row">
          ${verb} <b>u/${escapeHtml(d.modName)}</b>'s ${escapeHtml(d.originalAction)} of <code>${escapeHtml(d.targetId)}</code> · ${when} ago
          <br/><span class="cr-muted">${escapeHtml(d.reason)} (${src})</span>
        </div>`;
      }).join("");

  const perMod = status.perMod.length
    ? `<div class="cr-detail-text"><b>Rolling 30-day flag counts:</b><br/>${
        status.perMod.map((m) => `u/${escapeHtml(m.name)}: ${m.count}`).join(" · ")
      }</div>`
    : "";

  openDetailHtml("Private Doc", intro + buttons + perMod + `<div class="cr-detail-text"><b>Recent flags:</b></div>` + disputeBlock);

  document.querySelectorAll<HTMLButtonElement>("#detail-body button[data-so]").forEach((btn) => {
    btn.addEventListener("click", () => setSecondOpinionMode(btn.dataset.so as SecondOpinionMode));
  });
}

async function setSecondOpinionMode(mode: SecondOpinionMode): Promise<void> {
  // Surgeon mode auto-corrects mod calls — explicit confirmation before enabling.
  if (mode === "surgeon") {
    const ok = confirm(
      "Enable Surgeon mode?\n\nDr. Mod will AUTOMATICALLY undo mod removals/approvals it disagrees with and DM the mod with the reasoning.\n\nThis overrides present moderators. Recommended for solo or small mod teams. Click OK to enable, Cancel to keep advisory mode."
    );
    if (!ok) return;
  }
  const res = await fetch(ApiEndpoint.SaveSecondOpinion, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  const data = (await res.json()) as SaveSecondOpinionResult;
  showToast(data.message);
  await loadDashboard();
  await runSecondOpinion();
}

async function editSettings(): Promise<void> {
  const result = await showForm({
    title: "🔧 Settings",
    fields: [
      { name: "thresholdHours", label: "Crisis threshold (hours)", type: "string", required: false },
      {
        name: "mode",
        label: "Moderation mode",
        type: "select",
        options: [
          { label: "Surrogate (auto approve / remove)", value: "surrogate" },
          { label: "Assistant (filter to mod queue)", value: "assistant" },
          { label: "Off", value: "off" },
        ],
      },
    ],
    acceptLabel: "Save",
  });
  if (result.action !== "SUBMITTED") return;
  const values = (result as { values: { thresholdHours?: string; mode?: string[] | string } }).values;
  const thresholdHours = values.thresholdHours ? Number(values.thresholdHours) : undefined;
  const mode = Array.isArray(values.mode) ? values.mode[0] : values.mode;
  const res = await fetch(ApiEndpoint.SaveSettings, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thresholdHours, mode }),
  });
  showToast(res.ok ? "Settings saved." : "Save failed — see logs.");
  await loadDashboard();
}

async function injectBrain(): Promise<void> {
  const result = await showForm({
    title: "🧠 Inject Brain",
    description: "Paste a Google Gemini API key (free tier at aistudio.google.com/apikey). Pick Surrogate to let the AI act, Assistant to file posts for review.",
    fields: [
      { name: "key", label: "Google Gemini API Key", type: "string", required: true },
      {
        name: "mode",
        label: "Moderation Style",
        type: "select",
        options: [
          { label: "Surrogate (auto-approve / remove)", value: "surrogate" },
          { label: "Assistant (filter to mod queue)", value: "assistant" },
        ],
      },
    ],
    acceptLabel: "Inject Brain",
  });
  if (result.action !== "SUBMITTED") return;
  const values = (result as { values: { key?: string; mode?: string[] | string } }).values;
  const key = values.key;
  const mode = Array.isArray(values.mode) ? values.mode[0] : values.mode;
  if (!key) {
    showToast("Injection failed — no key provided.");
    return;
  }
  const res = await fetch(ApiEndpoint.SaveBrain, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, mode: mode || "surrogate" }),
  });
  showToast(res.ok ? "Brain injected." : "Save failed — see logs.");
  await loadDashboard();
}

async function resetBrain(): Promise<void> {
  const res = await fetch(ApiEndpoint.ResetBrain, { method: "POST" });
  if (res.ok) {
    showToast("Brain cleared.");
    await loadDashboard();
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

let booted = false;

export function boot(): void {
  if (booted) return;
  booted = true;
  document.getElementById("detail-close")?.addEventListener("click", () => {
    document.getElementById("detail-panel")?.classList.add("hidden");
  });
  console.log("[DR. Mod] Control Room loaded.");
  loadDashboard();
  setInterval(refreshHeartbeatUI, 1000);
  setInterval(loadDashboard, 30000);
}

if (typeof document !== "undefined" && document.body?.classList.contains("app")) {
  boot();
}
