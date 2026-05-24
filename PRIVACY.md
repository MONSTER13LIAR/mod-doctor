# Privacy Policy — Dr. Mod

*Last updated: 2026-05-24*

Dr. Mod is a moderation tool installed on subreddits by their moderators. It runs inside the [Reddit Developer Platform](https://developers.reddit.com/) (Devvit), which means Reddit's own privacy policy also applies to everything that happens inside the app.

This policy describes what Dr. Mod itself stores, why it stores it, and who it talks to.

## What Dr. Mod stores

Inside the per-subreddit Redis database Reddit provides to Devvit apps, Dr. Mod stores:

- **Moderator activity** — usernames of the subreddit's moderators, the timestamp of their most recent moderation action, a per-mod action count, and (if Mod Team Care messaged them) the timestamp of the last wellness check-in.
- **Subreddit pulse** — the timestamp of the most recent human moderator action on the subreddit. Used to determine whether the sub is `STABLE`, `CRISIS`, or `WAITING`.
- **AI configuration** — the Gemini API key a moderator pastes into the dashboard, the chosen AI mode (Surrogate / Assistant / Off), the Private Doc mode (Surgeon / Nurse / Off), and any crisis-threshold override.
- **Appeals** — when the AI removes a post, Dr. Mod stores the post ID, the post author's username, the AI's reason, and the appeal status (`removed` / `requested` / `restored` / `upheld`). Used so a moderator can review the appeal from the dashboard.
- **Weekly counters and snapshots** — running totals of how many posts the AI approved, removed, or suggested for review in the current week, plus a snapshot of the moderator team taken on Monday so the weekly report can show who joined or left.
- **Anti-double-count flags** — short-TTL markers (`dr_mod:ai_acted:<thingId>`) set when Dr. Mod itself takes a moderation action, used so its own actions don't get miscounted as a human moderator pulse.

Dr. Mod does **not** store personal information beyond Reddit usernames. It does not collect email addresses, real names, IP addresses, device identifiers, or any tracking data.

## Where the data lives

All data is stored in the Redis database Reddit provides as part of the Devvit platform, scoped to the subreddit where Dr. Mod is installed. The data never leaves Reddit's infrastructure except for the AI calls described below.

## Who Dr. Mod talks to

To perform AI-assisted moderation, Dr. Mod sends data to **Google Gemini** (`generativelanguage.googleapis.com`). This happens in three cases:

1. **Crisis surgery** — when the AI Surgeon is reviewing a new post during a CRISIS, Dr. Mod sends the post's title and body to Gemini and receives an approve/reject verdict.
2. **Private Doc (second opinion)** — when a moderator removes or approves a post and the heuristics can't decide, Dr. Mod sends the post's title, body, and the moderator's action to Gemini for a second opinion.
3. **Find Good Moderators** — when a moderator runs the "Find Good Moderators" scan, Dr. Mod sends recent commenter usernames and comment excerpts to Gemini for ranking.

Google Gemini's own [terms](https://ai.google.dev/terms) and [privacy policy](https://policies.google.com/privacy) apply to anything sent to that API. Dr. Mod uses either the app-level default Gemini key or a moderator-provided "bring your own key" — in both cases the data flow is the same.

No other third-party services receive data from Dr. Mod.

## How long data is kept

- Most data persists for as long as the app is installed on the subreddit.
- Anti-double-count flags expire automatically after a few minutes.
- Weekly counters reset each week.
- If a moderator uninstalls the app or runs the "Reset Brain" action, the corresponding data is removed from Redis.

## What about the public Live Monitor?

Dr. Mod creates one pinned "Live Monitor" post per subreddit that displays the current status (STABLE / CRISIS / WAITING) and a pulse animation. This post is public to anyone who can view the subreddit. It does not display any personal information about moderators beyond the aggregate health status.

## Your rights

If you are a moderator of a subreddit running Dr. Mod, you can:

- Uninstall the app from the subreddit's settings — this removes Dr. Mod's data for that subreddit from Redis.
- Use the "Reset Brain" action to clear the stored AI key.
- Disable AI features by setting both AI Surrogate and Private Doc to `Off`.

If you are a user whose post or comment was processed by Dr. Mod and you want it removed from the app's data, contact the moderators of the subreddit where Dr. Mod is installed, or open an issue on the repository linked below.

## Changes

This policy may be updated as Dr. Mod's features change. The current version is always available at [PRIVACY.md on GitHub](https://github.com/MONSTER13LIAR/mod-doctor/blob/main/PRIVACY.md).

## Contact

Open an issue at [github.com/MONSTER13LIAR/mod-doctor/issues](https://github.com/MONSTER13LIAR/mod-doctor/issues) for any privacy questions.
