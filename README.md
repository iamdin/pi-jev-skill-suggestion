# pi-jev-skill-suggestion

Pi dumps every installed skill into the system prompt. With hundreds of skills that burns context and makes near-duplicates hard to tell apart.

This extension **strips** `<available_skills>`, then asks [TypeSafe Jev](https://typesafe.ai) which skill — if any — to load. At most one skill per turn, or quiet.

## Install

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

3. Start Pi as usual. First session with a key set asks you to pick a mode (`tool` or `auto`).

> **No key → extension no-ops.** Pi keeps its normal skill listing; nothing is stripped.

## How to use

### `tool` mode (default)

You chat normally. The agent no longer sees the skill roster in the system prompt. When a task looks skill-shaped, it should call:

```text
skill_suggest({ task: "<what the user asked>" })
```

| Result | What the agent should do |
| --- | --- |
| `{ "skill": "foo", "location": ".../SKILL.md", ... }` | `read` that file and follow it |
| `{ "skill": null, "reason": "..." }` | continue without a skill |

You do not call the tool yourself. Switch mode anytime with `/jev-skill-mode`.

### `auto` mode

You chat normally. After each user prompt, the extension runs Jev itself:

- **Fit found** → a visible message is injected, e.g.  
  `Skill recommendation for this turn: skill / location / reason`  
  The agent is told to read that file.
- **No fit / gate says quiet / API error** → nothing injected; the turn continues.

> **Cost / latency:** every user prompt triggers at least one Jev call before the agent starts — including quiet turns like `what is 2+2?`. Prefer `tool` if you only want routing when the model decides a skill might help.

In `auto`, `skill_suggest` is deactivated so the model does not double-route.

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

Skill-shaped asks should route to a skill (or recommend one in `auto`). Quiet asks like `2+2` should stay quiet.

## How it works

### In the Pi session

```text
user user prompt
           │
           ▼
   strip <available_skills>
   inject short mode guidance
           │
     ┌─────┴─────┐
     │           │
  tool mode   auto mode
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

### Inside `suggest()`

Same two-stage idea as the [skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion.md):

1. **Gate** — three Noul questions (act on user's system? needs a documented procedure? would prose alone suffice?). Mean oriented score; below **0.30** → no skill.
2. **Wide rank** — roster chunked (≤254 skills + `none_of_these` per call). Up to **3** concurrent `systemOne` Choice calls.
3. **Shortlist** — merge chunk rankings by score; always keep the best chunk; drop other chunks whose `none_of_these` ≥ **0.50**; keep top `shortlistSize` (default **3**).
4. **Narrow** — read ~**700** chars of each shortlisted `SKILL.md`, Choice + per-candidate fits Noul. Winner must beat fits **0.40**; else none.

Timeout / API error → **fail open** (no skill; turn continues).

### Config

Priority:

1. `JEV_SKILL_MODE=tool|auto` — overrides **mode only**
2. `.pi/jev-skill-suggestion.json`
3. `~/.pi/agent/jev-skill-suggestion.json`
4. first-session picker → writes global

```json
{ "mode": "tool", "shortlistSize": 3 }
```

`shortlistSize` = how many stage-1 candidates enter stage-2 (clamped `1..32`). `/jev-skill-mode` updates global `mode` and keeps the current `shortlistSize`.

## Privacy

**Sent to TypeSafe:** current task / user prompt; skill names + descriptions; short `SKILL.md` excerpt for shortlisted candidates.

**Not sent:** chat history, workspace files, credentials, tool results, system prompt.

## Develop

```bash
bun install
bun run check   # tsc + strip/config + router asserts
```

```text
index.ts               extension entry (strip, modes, tool)
src/config.ts          mode + shortlistSize
src/strip.ts           listing strip + guidance + auto message
src/router.ts          two-stage Jev suggest()
scripts/check-strip.ts
scripts/check-router.ts
```

## See also

- [Cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion.md)
- [Hermes router](https://github.com/DECRUX9812/typesafe-skill-router)
- [Codex router](https://github.com/droid-Q/jev-skill-router)

## License

MIT
