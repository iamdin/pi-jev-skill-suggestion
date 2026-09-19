# pi-jev-skill-suggestion

Pi extension that stops stuffing every skill into the system prompt. It strips `<available_skills>`, then routes skill choice through [TypeSafe Jev](https://typesafe.ai).

## Install

```bash
export TYPESAFE_API_KEY=ts_...   # https://console.typesafe.ai/settings/keys

pi install git:github.com/iamdin/pi-jev-skill-suggestion
# or for local work:
pi -e ./index.ts
```

No API key → extension does nothing. Pi keeps its normal skill listing.

## Modes

Always strips the skill listing. Then:

| Mode | What happens |
| --- | --- |
| `tool` | Model calls `skill_suggest` when it thinks a skill may help |
| `auto` | After each user prompt, extension may inject one skill recommendation (quiet if none fits) |

First session with a key set asks you to pick. Change later with `/jev-skill-mode`.

Resolution order:

1. `JEV_SKILL_MODE=tool|auto`
2. `.pi/jev-skill-suggestion.json`
3. `~/.pi/agent/jev-skill-suggestion.json`
4. first-session picker → writes global config

`/jev-skill-mode` writes the global file. Env still wins on the next session.

Example config:

```json
{ "mode": "tool" }
```

## How routing works

Same two-stage protocol as the [skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion.md):

1. **Gate** — does this turn want a skill at all?
2. **Wide choice** — pick candidates from the roster (chunked; includes `none_of_these`)
3. **Narrow** — shortlist of 3 + short `SKILL.md` excerpts → at most one winner

Defaults: gate `0.30`, fits `0.40`. Fail open on timeout / API error.

## Privacy

**Sent to TypeSafe:** current task/prompt text; skill names + descriptions; short `SKILL.md` excerpt for shortlisted candidates.

**Not sent:** conversation history, workspace files, credentials, tool results, system prompt.

## Layout

```text
index.ts
src/config.ts   # mode: env / project / global
src/strip.ts    # strip listing + mode guidance
src/router.ts   # two-stage Jev suggest()
```

## Related

- [TypeSafe skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion.md)
- [Hermes typesafe-skill-router](https://github.com/DECRUX9812/typesafe-skill-router)
- [Codex jev-skill-router](https://github.com/droid-Q/jev-skill-router)

## License

MIT
