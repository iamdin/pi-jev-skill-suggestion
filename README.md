# pi-jev-skill-suggestion

Pi dumps every installed skill into the system prompt. With hundreds of skills that burns context and makes near-duplicates hard to tell apart.

This extension strips `<available_skills>`, then asks [TypeSafe Jev](https://typesafe.ai) which skill — if any — to load.

## Install

```bash
pi install git:github.com/iamdin/pi-jev-skill-suggestion
```

Or try without installing:

```bash
pi -e ./index.ts
```

## API key

Set before starting Pi (shell profile, direnv, or the process env):

```bash
export TYPESAFE_API_KEY=ts_...   # https://console.typesafe.ai/settings/keys
```

No key → extension no-ops. Pi keeps its normal skill listing.

## Try this

With the key exported, start Pi, pick a mode on first session (`tool` or `auto`), then ask something skill-shaped:

```text
create a short pitch deck as pptx
```

```text
review this diff against the repo standards
```

```text
what is 2+2?
```

In `tool` mode the model should call `skill_suggest`. In `auto` mode a recommendation may appear after your prompt. Quiet turns should stay quiet.

## Modes

Both modes strip the skill listing first.

| Mode | Trigger |
| --- | --- |
| `tool` | Model calls `skill_suggest` when needed |
| `auto` | Extension suggests after each user prompt; quiet if nothing fits |

Switch later with `/jev-skill-mode`.

### Config priority

1. `JEV_SKILL_MODE=tool\|auto`
2. `.pi/jev-skill-suggestion.json`
3. `~/.pi/agent/jev-skill-suggestion.json`
4. first-session picker (writes global)

```json
{ "mode": "tool", "shortlistSize": 3 }
```

`shortlistSize` is how many stage-1 candidates enter stage-2 rerank (default `3`, clamped `1..32`). `/jev-skill-mode` writes the global file and keeps the current `shortlistSize`. Env still overrides **mode** next session.

In `auto` mode, `skill_suggest` is deactivated so the model does not double-route.

## How it works

Same two-stage protocol as the [skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion.md):

1. **Gate** — should this turn use a skill? (threshold `0.30`)
2. **Wide** — chunked choice over the roster (`none_of_these`, ≤3 concurrent `systemOne` calls)
3. **Shortlist** — merge chunks by score (drop high-`none` non-best chunks), keep top `shortlistSize`
4. **Narrow** — ~700 chars of each shortlisted `SKILL.md`; pick at most one (fits `0.40`)

A 1000-skill roster is scanned in stage 1; only the shortlist is re-ranked. Timeout / API error → fail open (no skill, turn continues).

## Privacy

**Sent:** current task / user prompt; skill names + descriptions; short `SKILL.md` excerpt for shortlisted candidates.

**Not sent:** chat history, workspace files, credentials, tool results, system prompt.

## Develop

```bash
bun install
bun run check   # tsc + strip/config + router asserts
```

```text
index.ts               extension entry
src/config.ts          mode + shortlistSize
src/strip.ts           listing strip + guidance
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
