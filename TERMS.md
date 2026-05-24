# Terms & Conditions — Dr. Mod

*Last updated: 2026-05-24*

## What Dr. Mod is

Dr. Mod is an open-source moderation tool for Reddit subreddits, built on the [Reddit Developer Platform](https://developers.reddit.com/) (Devvit). It is installed by the moderators of a subreddit and is intended to assist that subreddit's moderation team.

Using Dr. Mod means you agree to the terms below in addition to [Reddit's User Agreement](https://www.redditinc.com/policies/user-agreement) and the [Devvit App Rules](https://developers.reddit.com/docs/guidelines).

## Who can install it

Dr. Mod can be installed only by subreddit moderators with the appropriate permissions. By installing it, the installing moderator confirms they have authorization to operate moderation tooling on that subreddit and to add an AI-assisted moderation flow.

## AI-assisted moderation — important caveats

Dr. Mod can use Google Gemini to take or recommend moderation actions (approving posts, removing posts, flagging mod calls). AI moderation is **not perfect**:

- The AI Surgeon (Surrogate mode) can remove posts during a CRISIS. Safety default: if the AI is unreachable or unsure, it removes rather than approves.
- The Private Doc can auto-correct what it judges to be a clearly wrong call by a human moderator (Surgeon mode), or simply flag it via modmail (Nurse mode).
- The "Find Good Moderators" feature uses AI to rank candidates. Its rankings are suggestions, not endorsements.

**The human moderators of a subreddit remain ultimately responsible for the moderation decisions made there.** Dr. Mod is a tool that assists; it does not replace moderator judgment. Moderators should review AI actions periodically using the dashboard, weekly health report, and appeal flow.

Users whose posts are removed by Dr. Mod can reply `APPEAL` to the removal comment, which routes the case back to the human mod team via the dashboard's User Appeal Flow.

## API keys and quotas

Moderators may provide their own Google Gemini API key ("BYOK") via the dashboard's *Inject Brain* form. Any API usage and billing against that key is the responsibility of the moderator who provided it.

If no key is provided, Dr. Mod falls back to an app-level default key (subject to daily caps) so basic AI features work out-of-the-box. The default key may be rate-limited or disabled at any time without notice.

## No warranty

Dr. Mod is provided "as is" and "as available", without warranty of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, and non-infringement. To the maximum extent permitted by law, the maintainer is not liable for any claim, damages, or other liability arising from the use of Dr. Mod — including but not limited to incorrect AI moderation decisions, missed crisis windows, false-positive removals, or downtime.

## Open source

The source code for Dr. Mod is available at [github.com/MONSTER13LIAR/mod-doctor](https://github.com/MONSTER13LIAR/mod-doctor) under the license in the repository's [LICENSE](https://github.com/MONSTER13LIAR/mod-doctor/blob/main/LICENSE) file.

## Changes

These terms may be updated as Dr. Mod's features change. The current version is always available at [TERMS.md on GitHub](https://github.com/MONSTER13LIAR/mod-doctor/blob/main/TERMS.md).

## Contact

Open an issue at [github.com/MONSTER13LIAR/mod-doctor/issues](https://github.com/MONSTER13LIAR/mod-doctor/issues) for any questions.
