# Dr. Mod

**A doctor for your moderator team.** Most Reddit tools moderate *content and users*; Dr. Mod looks after the *humans who do the moderating* — tracking their pulse, covering for them when they go quiet, and offering a second pair of eyes on every call they make.

Built on [Devvit](https://developers.reddit.com/) for the **Reddit Mod Tools and Migrated Apps Hackathon** (New Mod Tool category).

---

## The metaphor

Every subreddit has a **pulse** — the heartbeat of human moderator actions. When mods go quiet past a threshold (default 30 minutes), the sub enters **CRISIS** and Dr. Mod's AI surgeon steps in to keep things stable until a real mod returns. When a mod has been silent for weeks, Dr. Mod sends a gentle modmail check-in. When mod calls look wrong, a Private Doc politely flags or corrects them.

It's framed as *team wellness*, never surveillance. The judges are mods themselves — a narc tool would lose.

---

## What it does — 12 powers

The Control Room dashboard (mod-only) surfaces every capability as a tile:

| | Power | What it does |
|---|---|---|
| 🩻 | **Sub Diagnosis** | Hero tile: 0–100 health score + one-line diagnosis headline. |
| 🏥 | **Crisis Detection** | Tracks time since the last human mod action. Pulse goes flat → sub enters CRISIS. |
| 🤖 | **AI Surgeon (Surrogate)** | During CRISIS, AI auto-moderates new posts. |
| 🧑‍⚕️ | **Private Doc** | Review of present mod actions + AI **Auto-Rule Doctor** suggestions. |
| 🩺 | **Mod Team Vitals** | Per-mod health: who's active, who's idle, who's flatlined. |
| 📬 | **Mod Team Care** | Auto-modmail flatlined mods with a check-in. |
| 🎯 | **Find Good Moderators** | AI ranks recent subreddit contributors as mod candidates. |
| 🗣️ | **User Appeal Flow** | User appeals for AI removals directly to the mod team. |
| 📊 | **Weekly Health Report** | Sunday summary of team activity and community growth. |
| 🔥 | **Burnout Watch** | Predictive heuristics to catch mod exhaustion before they flatline. |
| 🌡️ | **Sub Temperature** | Community toxicity thermometer with trend analysis. |
| 🔧 | **Settings** | Thresholds, AI modes, and "Succession Planning" recruiter config. |

The Live Monitor (public, pinned) is a separate webview that shows the animated pulse line, current status, and the **Sub Diagnosis** score. Mods see a "🩺 Open Dashboard" launcher on top of it.

---

## Architecture (quick tour)

Three TypeScript source roots, each with its own tsconfig project:

- **`src/server/`** — Devvit Node server. Every HTTP request, trigger, menu click, scheduled task, and form submission flows through one `onRequest()` dispatcher in `src/server/server.ts`.
- **`src/client/`** — Two browser webviews: `heartbeat.ts` (Live Monitor) and `splash.ts` (dashboard overlay, mounted inside the monitor).
- **`src/shared/`** — Types, the `ApiEndpoint` path map, Redis key constants. Imported by both sides.

State lives in **Redis** under `dr_mod:` keys. AI calls go to **Google Gemini** (`generativelanguage.googleapis.com`); the host must be allow-listed in `devvit.json` under `permissions.http.domains`.

---

## Setup

Requirements: **Node ≥ 22.6.0** (uses `--experimental-strip-types` to run `tools/build.ts` directly).

```bash
npm install
npm run login         # one-time: devvit login
npm run dev           # devvit playtest on your dev subreddit
```

After installing the app on a subreddit:
1. Open the pinned Live Monitor post.
2. Click **🩺 Open Dashboard** (mod-only button).
3. Optionally inject a Gemini API key under **Settings → Inject Brain** to enable AI powers. A built-in default brain handles light use without a key.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | `devvit playtest` — live hot-reload on the dev sub. |
| `npm run build` | esbuild bundle (client → `public/`, server → `dist/server/`). |
| `npm run deploy` | Build + `devvit upload`. Ships a new version to the registry. |
| `npm run launch` | Build + deploy + `devvit publish` — submits to the App Directory. |
| `npm run type-check` | `tsc --build` across the three tsconfig projects. The only static gate. |
| `npm run login` | `devvit login`. |

There's no test runner or linter — iterate by running `npm run dev` and reading the playtest logs (server logs use the `[DR. Mod]` prefix).

---

## License

See [LICENSE](./LICENSE).
