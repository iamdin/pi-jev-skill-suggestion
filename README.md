# pi-jev-skill-suggestion

Pi dumps every installed skill into the system prompt. With hundreds of skills that burns context and makes near-duplicates hard to tell apart.

This extension **strips** `<available_skills>`, then asks [TypeSafe Jev](https://typesafe.ai) which skill — if any — to load. At most one skill per turn, or quiet.

## Install

```bash
pi install npm:pi-jev-skill-suggestion
```

Or from git:

```bash
pi install git:github.com/iamdin/pi-jev-skill-suggestion
```

Or clone and load once without installing:

```bash
git clone https://github.com/iamdin/pi-jev-skill-suggestion.git
cd pi-jev-skill-suggestion
bun install
pi -e ./index.ts
```

## Setup

1. Get a TypeSafe key: https://console.typesafe.ai/settings/keys
2. Export it **before** starting Pi (shell profile, direnv, or process env):

```bash
export TYPESAFE_API_KEY=ts_...
```

3. Start Pi as usual. First session with a key set asks when Jev should suggest: `onDemand`, `onPrompt`, both, or off.

> **No key → extension no-ops.** Pi keeps its normal skill listing; nothing is stripped.

## How to use

Two triggers, each switched on with `true`. Turn on one or both:

| Trigger | When Jev runs |
| --- | --- |
| `onDemand` | the agent calls `skill_suggest` when it thinks a skill may help |
| `onPrompt` | the extension asks before every user prompt |

Change anytime with `/jev-skill-suggestion`.

### `onDemand`

You chat normally. The agent no longer sees the skill roster in the system prompt. When a task looks skill-shaped, it should call:

```text
skill_suggest({ task: "<what the user asked>" })
```

| Result | What the agent should do |
| --- | --- |
| `{ "skill": "foo", "location": ".../SKILL.md", ... }` | `read` that file and follow it |
| `{ "skill": null, "reason": "..." }` | continue without a skill |

If the suggested skill is already in context (read earlier and not compacted away), `next` says so instead of asking for a re-read.

You do not call the tool yourself.

### `onPrompt`

You chat normally. After each user prompt, the extension runs Jev itself:

- **Fit found** → a visible message is injected, e.g.  
  `Skill recommendation for this turn: skill / location / reason`  
  The agent is told to read that file.
- **No fit / gate says quiet / API error** → nothing injected; the turn continues.
- **`/skill:name` prompt** → no Jev call; you already picked.
- **Ack / go-ahead** (`ok`, `thanks`, `继续`, `lgtm`, …) or **input sent by another extension** → no Jev call.
- **Winner already in context** (read earlier and not compacted away) → nothing injected.

> **Cost / latency:** every user prompt triggers at least one Jev call before the agent starts — including quiet turns like `what is 2+2?`. Exceptions: the skips above, and rosters below `minSkillsToRoute`. Use only `onDemand` if you only want routing when the model decides a skill might help.

With only `onPrompt`, `skill_suggest` is deactivated.

### Both on

Each user prompt is routed as in `onPrompt`, and `skill_suggest` stays active for **sub-tasks** that come up mid-turn (e.g. the deck is done, now it needs a review). The agent is told not to re-route the user's own request. Same per-prompt cost as `onPrompt`, plus any tool calls the model makes.

Both off = extension off: Pi keeps its listing.

### Shadow (evaluate before switching)

`"shadow": true` keeps Pi's native skill listing untouched and routes every prompt with Jev **in the background** — nothing is stripped or injected, no added latency. Only the session records what Jev would have picked next to what the model actually read. Run it for a while, then check `/jev-skill-stats`.

### Stats

Every decision is recorded **inside the Pi session** as a `custom` entry (`customType: "jev-skill-suggestion"`, never sent to the model), right next to the conversation it came from — open the session file to see why a turn got (or didn't get) a skill.

`/jev-skill-stats` summarizes this session's records:

- per trigger: calls, suggestions shown, **used** (the suggested `SKILL.md` was read in the same turn), errors, p50/p95 latency
- skipped prompts (no Jev call) by reason
- shadow: agreement between Jev and the model's own pick
- least-used skills (suggested ≥ 3 times) — candidates for better descriptions or removal

Across sessions (offline, from a clone): `bun scripts/stats.ts [sessions-dir]` — defaults to every session under `~/.pi/agent/sessions`; pass one project's folder to narrow it.

### What to try

```text
create a short pitch deck as pptx
```

```text
review this diff against the repo standards
```

```text
what is 2+2?
```

Skill-shaped asks should route to a skill (or get recommended with `onPrompt`). Quiet asks like `2+2` should stay quiet.

## How it works

### In the Pi session

```text
user user prompt
           │
           ▼
   strip <available_skills>
   inject short skill guidance
           │
     ┌─────┴─────┐
     │           │
  onDemand    onPrompt  
     │           │
     ▼           ▼
 agent may    extension calls
 call         suggest() now
 skill_suggest
     │           │
     └─────┬─────┘
           ▼
      suggest()
           │
     ┌─────┴──────┐
     │            │
  one skill     none
  (+ path)    (quiet / null)
```

Roster = installed skills that are not `disableModelInvocation`. Built each turn from Pi's skill list.

**Small roster → passthrough.** Below `minSkillsToRoute` skills (default **20**), the listing is cheap enough: nothing is stripped, Jev is never called, and `skill_suggest` is deactivated.

### Inside `suggest()`

Same two-stage idea as the [skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion.md):

1. **Gate** — three Noul questions (act on user's system? needs a documented procedure? would prose alone suffice?). Mean oriented score; below **0.30** → no skill.
2. **Wide rank** — roster chunked (≤254 skills + `none_of_these` per call). Up to **3** concurrent `systemOne` Choice calls.
3. **Shortlist** — when chunked, take each surviving chunk's winner (cross-chunk probs aren't comparable), then fill from the best chunk; drop other chunks whose `none_of_these` ≥ **0.50**; keep top `shortlistSize` (default **3**). Stage-2 compares them for real.
4. **Narrow** — read ~**700** chars of each shortlisted `SKILL.md`, Choice + per-candidate fits Noul. Winner must beat fits **0.40**; else none.

Timeout / API error → **fail open** (no skill; turn continues).

### Config

Priority:

1. `JEV_SKILL_ON_PROMPT` / `JEV_SKILL_ON_DEMAND` = `true|false|1|0` — each overrides **its trigger only**
2. `.pi/jev-skill-suggestion.json`
3. `~/.pi/agent/jev-skill-suggestion.json`
4. first-session picker → writes global

```json
{ "onPrompt": false, "onDemand": true, "shortlistSize": 3, "minSkillsToRoute": 20, "shadow": false, "log": true }
```

`shortlistSize` = how many stage-1 candidates enter stage-2 (clamped `1..32`). `minSkillsToRoute` = strip and route only at this many skills or more (`0` = always). `/jev-skill-suggestion` updates the global triggers and keeps the other values. `shadow` = log-only evaluation (see above). `log` = record decisions into the session (default `true`). Old `{ "mode": "tool" | "auto" }` files still load as `onDemand` / `onPrompt`.

## Privacy

**Sent to TypeSafe:** current task / user prompt; skill names + descriptions; short `SKILL.md` excerpt for shortlisted candidates.

**Not sent:** chat history, workspace files, credentials, tool results, system prompt.

**Session records** (stay in your local session files, never uploaded or sent to the model): a 16-hex **hash** + length of the prompt (not its text — the prompt is already in the session anyway), roster size, picked skill, scores, latency, and which roster skills were read. Turn off with `"log": false`.

## Develop

```bash
bun install
bun run check   # tsc + strip/config + router asserts
```

```text
index.ts               extension entry (strip, triggers, tool)
src/config.ts          triggers + shortlistSize + minSkillsToRoute
src/strip.ts           listing strip + guidance + onPrompt message
src/router.ts          two-stage Jev suggest()
src/history.ts         skills still in context (compaction-aware)
src/log.ts             session decision records + /jev-skill-stats
scripts/stats.ts       cross-session stats (offline)
test/check-strip.ts
test/check-router.ts
test/check-history.ts
test/check-log.ts
```

## See also

- [pi-jev-skill-bench](https://github.com/iamdin/pi-jev-skill-bench) — BM25 vs Jev across roster sizes 50–500
- [Cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion.md)
- [Hermes router](https://github.com/DECRUX9812/typesafe-skill-router)
- [Codex router](https://github.com/droid-Q/jev-skill-router)

## License

MIT
