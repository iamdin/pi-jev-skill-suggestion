import assert from "node:assert/strict";
import { none, pickShortlist, suggest, type RosterSkill, type SuggestClient } from "../src/router.ts";

const roster: RosterSkill[] = [
  { name: "pptx", description: "Build PowerPoint decks", filePath: "/tmp/pptx/SKILL.md" },
  { name: "pdf", description: "Edit PDF files", filePath: "/tmp/pdf/SKILL.md" },
  { name: "grep", description: "Search code", filePath: "/tmp/grep/SKILL.md" },
];

type Answers = Record<string, { type: "noul"; noul: number } | { type: "choice"; choice: string; probabilities: Record<string, number> }>;

function fakeClient(stage1: Answers, stage2?: Answers): SuggestClient {
  let calls = 0;
  return {
    systemOne: (async () => {
      calls += 1;
      const answers = calls === 1 ? stage1 : (stage2 ?? stage1);
      return { answers };
    }) as unknown as SuggestClient["systemOne"],
  };
}

const empty = await suggest(fakeClient({}), "hi", []);
assert.equal(empty.skill, null);
assert.match(empty.reason, /roster empty/);

const quietGate = await suggest(
  fakeClient({
    which: { type: "choice", choice: "pptx", probabilities: { pptx: 0.9, pdf: 0.05, grep: 0.05 } },
    "gate::acts_on_user_system": { type: "noul", noul: 0.1 },
    "gate::would_follow_documented_procedure": { type: "noul", noul: 0.1 },
    "gate::prose_suffices": { type: "noul", noul: 0.9 }, // inverted → 0.1; avg 0.1
  }),
  "what is a monad",
  roster,
);
assert.equal(quietGate.skill, null);
assert.match(quietGate.reason, /gate/);

const hit = await suggest(
  fakeClient(
    {
      which: { type: "choice", choice: "pptx", probabilities: { pptx: 0.7, pdf: 0.2, grep: 0.1 } },
      "gate::acts_on_user_system": { type: "noul", noul: 0.8 },
      "gate::would_follow_documented_procedure": { type: "noul", noul: 0.7 },
      "gate::prose_suffices": { type: "noul", noul: 0.2 }, // inverted → 0.8; avg ~0.77
    },
    {
      which: { type: "choice", choice: "pptx", probabilities: { pptx: 0.8, pdf: 0.1, none_of_these: 0.1 } },
      "fits::pptx": { type: "noul", noul: 0.9 },
      "fits::pdf": { type: "noul", noul: 0.2 },
      "fits::grep": { type: "noul", noul: 0.1 },
    },
  ),
  "make a slide deck for the launch",
  roster,
);
assert.equal(hit.skill, "pptx");
assert.equal(hit.location, "/tmp/pptx/SKILL.md");
assert.deepEqual(hit.shortlist, ["pptx", "pdf", "grep"]);

const capped = await suggest(
  fakeClient(
    {
      which: {
        type: "choice",
        choice: "pptx",
        probabilities: { pptx: 0.5, pdf: 0.3, grep: 0.2 },
      },
      "gate::acts_on_user_system": { type: "noul", noul: 0.8 },
      "gate::would_follow_documented_procedure": { type: "noul", noul: 0.7 },
      "gate::prose_suffices": { type: "noul", noul: 0.2 },
    },
    {
      which: { type: "choice", choice: "pptx", probabilities: { pptx: 0.9, none_of_these: 0.1 } },
      "fits::pptx": { type: "noul", noul: 0.9 },
    },
  ),
  "make slides",
  roster,
  { shortlistSize: 1 },
);
assert.deepEqual(capped.shortlist, ["pptx"]);
assert.equal(capped.skill, "pptx");

const lowFits = await suggest(
  fakeClient(
    {
      which: { type: "choice", choice: "pptx", probabilities: { pptx: 0.7, pdf: 0.2, grep: 0.1 } },
      "gate::acts_on_user_system": { type: "noul", noul: 0.8 },
      "gate::would_follow_documented_procedure": { type: "noul", noul: 0.7 },
      "gate::prose_suffices": { type: "noul", noul: 0.2 },
    },
    {
      which: { type: "choice", choice: "pptx", probabilities: { pptx: 0.6, none_of_these: 0.4 } },
      "fits::pptx": { type: "noul", noul: 0.2 },
      "fits::pdf": { type: "noul", noul: 0.1 },
      "fits::grep": { type: "noul", noul: 0.1 },
    },
  ),
  "make slides",
  roster,
);
assert.equal(lowFits.skill, null);
assert.match(lowFits.reason, /fits/);

const failed = none("routing failed open: boom");
assert.equal(failed.skill, null);
assert.equal(failed.gate, 0);

// Cross-chunk: weak early chunk must not FIFO-steal slots from a stronger later chunk.
assert.deepEqual(
  pickShortlist(
    [
      [
        ["weak-a", 0.2],
        ["weak-b", 0.15],
        ["weak-c", 0.1],
      ],
      [
        ["pptx", 0.8],
        ["pdf", 0.5],
        ["grep", 0.4],
      ],
    ],
    [0.1, 0.05],
    3,
  ),
  ["pptx", "pdf", "grep"],
);

// High nonePressure drops a non-best chunk even if its top score looks ok.
assert.deepEqual(
  pickShortlist(
    [
      [
        ["noise", 0.4],
        ["noise2", 0.3],
      ],
      [
        ["pptx", 0.7],
        ["pdf", 0.2],
      ],
    ],
    [0.9, 0.1],
    2,
  ),
  ["pptx", "pdf"],
);

console.log("router thresholds + fail-open ok");
