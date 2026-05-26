import { ApiEndpoint, formatDuration, type InitResponse } from "../shared/api.ts";
import { boot as bootDashboard } from "./splash.ts";

type Status = "STABLE" | "CRISIS" | "WAITING";

const VIEWBOX_W = 1000;
const BASELINE_Y = 100;
const SAMPLE_COUNT = 240;
const SCROLL_MS = 32;
const SIGNAL_POLL_MS = 1500;

let status: Status = "STABLE";
let lastActionTimestamp: number | null = null;
let bpm = 60;
let phase = 0;
let isMod = false;
let signalPollHandle: number | null = null;
let dashboardBooted = false;

const samples: number[] = new Array(SAMPLE_COUNT).fill(BASELINE_Y);

async function fetchVitals(): Promise<void> {
  try {
    const res = await fetch(ApiEndpoint.Init);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = (await res.json()) as InitResponse;
    status = data.status;
    lastActionTimestamp = data.lastActionTimestamp ?? null;
    const wasMod = isMod;
    isMod = !!data.isModerator;
    setSub(data);
    applyStatus(status);
    bpm = bpmForStatus(status);
    renderReadout();
    renderDiagnosis(data.diagnosis);
    updateLauncher();
    if (isMod && !signalPollHandle) startSignalPolling();
    if (!isMod && wasMod) stopSignalPolling();
  } catch (err) {
    console.error("[Heartbeat] init fetch failed:", err);
  }
}

function setSub(data: InitResponse): void {
  const el = document.getElementById("hb-sub");
  if (!el) return;
  
  // Use subredditName if available, otherwise just say "Live Monitor"
  const subName = data.subredditName && data.subredditName !== "unknown" 
    ? `r/${data.subredditName}` 
    : "";
    
  el.textContent = subName ? `Live Monitor · ${subName}` : "Live Monitor";
  console.log("[Heartbeat] Updated header to:", el.textContent);
}

function bpmForStatus(s: Status): number {
  if (s === "CRISIS") return 140;
  if (s === "WAITING") return 40;
  return 64;
}

function applyStatus(s: Status): void {
  const body = document.body;
  body.classList.remove("crisis", "waiting", "stable");
  body.classList.add(s.toLowerCase());

  const pill = document.getElementById("hb-status");
  if (pill) {
    pill.classList.remove("stable", "crisis", "waiting");
    pill.classList.add(s.toLowerCase());
    pill.textContent = s;
  }

  const footText = document.getElementById("hb-foot-text");
  if (footText) {
    footText.textContent =
      s === "CRISIS"
        ? "No human mod activity detected — surgical coverage engaged."
        : s === "WAITING"
        ? "Waiting for the first moderator pulse."
        : "Monitoring moderator activity in real time.";
  }
}

function renderReadout(): void {
  const bpmEl = document.getElementById("hb-bpm");
  if (bpmEl) bpmEl.textContent = status === "WAITING" ? "—" : `${bpm}`;

  const lastEl = document.getElementById("hb-last");
  if (!lastEl) return;
  if (!lastActionTimestamp || lastActionTimestamp < 0) {
    lastEl.textContent = "—";
    return;
  }
  const ms = Date.now() - lastActionTimestamp;
  lastEl.textContent = `${formatDuration(ms)} ago`;
}

function renderDiagnosis(diag?: any): void {
  const container = document.getElementById("hb-diagnosis");
  if (!container) return;

  if (!diag) {
    container.classList.add("hidden");
    return;
  }

  container.classList.remove("hidden");
  
  // Apply tier class
  container.classList.remove("healthy", "stable", "concerning", "warning", "critical");
  container.classList.add(diag.tier);

  const scoreEl = document.getElementById("hb-diag-score");
  if (scoreEl) scoreEl.textContent = String(diag.score);

  const headlineEl = document.getElementById("hb-diag-headline");
  if (headlineEl) headlineEl.textContent = diag.headline;

  const deductionsEl = document.getElementById("hb-diag-deductions");
  if (deductionsEl) {
    const items = (diag.deductions || []) as Array<{ label: string; amount: number }>;
    if (items.length > 0) {
      deductionsEl.classList.remove("hidden");
      deductionsEl.innerHTML = items
        .map((d) => `<li class="hb-diag-tag">${d.label}</li>`)
        .join("");
    } else {
      deductionsEl.classList.add("hidden");
    }
  }
}

function pulseSample(t: number): number {
  const p = gaussian(t, 0.18, 0.04, 6);
  const q = gaussian(t, 0.42, 0.012, -14);
  const r = gaussian(t, 0.46, 0.012, 60);
  const s = gaussian(t, 0.5, 0.012, -22);
  const tw = gaussian(t, 0.72, 0.06, 10);
  const noise = (Math.random() - 0.5) * 0.6;
  return BASELINE_Y - (p + q + r + s + tw) + noise;
}

function gaussian(t: number, mu: number, sigma: number, amp: number): number {
  const d = t - mu;
  return amp * Math.exp(-(d * d) / (2 * sigma * sigma));
}

function flatSample(): number {
  if (status === "WAITING") return BASELINE_Y;
  return BASELINE_Y + (Math.random() - 0.5) * 1.4;
}

function tick(): void {
  const beatLengthMs = 60_000 / Math.max(1, bpm);
  const samplesPerBeat = beatLengthMs / SCROLL_MS;
  const sample =
    status === "CRISIS" || status === "WAITING"
      ? flatSample()
      : pulseSample(phase / samplesPerBeat);

  samples.shift();
  samples.push(sample);
  phase += 1;
  if (phase >= samplesPerBeat) phase = 0;
  drawTrace();
}

function drawTrace(): void {
  const trace = document.getElementById("hb-trace");
  const traceBg = document.getElementById("hb-trace-bg");
  const cursor = document.getElementById("hb-cursor");
  if (!trace || !traceBg || !cursor) return;

  const stepX = VIEWBOX_W / (SAMPLE_COUNT - 1);
  let d = `M 0 ${(samples[0] ?? BASELINE_Y).toFixed(2)}`;
  for (let i = 1; i < SAMPLE_COUNT; i++) {
    d += ` L ${(i * stepX).toFixed(2)} ${(samples[i] ?? BASELINE_Y).toFixed(2)}`;
  }
  trace.setAttribute("d", d);
  traceBg.setAttribute("d", d);

  cursor.setAttribute("cx", String(VIEWBOX_W));
  cursor.setAttribute("cy", (samples[SAMPLE_COUNT - 1] ?? BASELINE_Y).toFixed(2));
}

// --- Dashboard overlay -----------------------------------------------------

// Mods get a button right on the monitor to open the dashboard in place — no
// menu round-trip, no navigation. This is the reliable popup path; the menu
// signal mechanism is a secondary route for the subreddit-level menu.
function updateLauncher(): void {
  const btn = document.getElementById("hb-dash-launcher");
  if (!btn) return;
  btn.classList.toggle("is-visible", isMod);
}

function startSignalPolling(): void {
  if (signalPollHandle) return;
  // Immediate check (covers the "navigated here from the subreddit menu" case)
  void checkSignal();
  signalPollHandle = window.setInterval(checkSignal, SIGNAL_POLL_MS);
}

function stopSignalPolling(): void {
  if (signalPollHandle) {
    window.clearInterval(signalPollHandle);
    signalPollHandle = null;
  }
}

async function checkSignal(): Promise<void> {
  try {
    const res = await fetch(ApiEndpoint.DashboardSignal);
    if (!res.ok) return;
    const data = (await res.json()) as { open?: boolean };
    if (data.open) await openDashboard();
  } catch (err) {
    console.warn("[Heartbeat] signal poll failed:", err);
  }
}

async function openDashboard(): Promise<void> {
  const overlay = document.getElementById("hb-dash-overlay");
  if (!overlay) return;
  overlay.setAttribute("aria-hidden", "false");
  overlay.classList.add("is-open");
  if (!dashboardBooted) {
    dashboardBooted = true;
    // Statically bundled (see import at top) so it always loads inside the
    // Reddit webview — a dynamic import() does not resolve reliably there.
    try {
      bootDashboard();
    } catch (err) {
      console.error("[Heartbeat] failed to boot dashboard module:", err);
    }
  }
}

function closeDashboard(): void {
  const overlay = document.getElementById("hb-dash-overlay");
  if (!overlay) return;
  overlay.setAttribute("aria-hidden", "true");
  overlay.classList.remove("is-open");
}

document.getElementById("hb-dash-launcher")?.addEventListener("click", () => void openDashboard());
document.getElementById("hb-dash-close")?.addEventListener("click", closeDashboard);
document.getElementById("hb-dash-scrim")?.addEventListener("click", closeDashboard);

console.log("[Heartbeat] Monitor loaded.");
fetchVitals();
drawTrace();
setInterval(tick, SCROLL_MS);
setInterval(renderReadout, 1000);
setInterval(fetchVitals, 30_000);
