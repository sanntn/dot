import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutionReportSchema, PlanSchema, ReviewSchema, firstSentence, planHeadline, reviewHeadline } from "@dot/shared";

test("firstSentence takes the first sentence and collapses whitespace", () => {
  assert.equal(firstSentence("Fix the  login bug.\nThen more text. And more."), "Fix the login bug.");
  assert.equal(firstSentence("No full stop here"), "No full stop here");
  assert.equal(firstSentence("v1.2 ships. Done."), "v1.2 ships.");
});

test("firstSentence cuts a long sentence at the limit", () => {
  const out = firstSentence("word ".repeat(100), 40);
  assert.ok(out.length <= 40);
  assert.ok(out.endsWith("..."));
});

test("an artifact saved before headlines existed falls back to its summary text", () => {
  const oldPlan = { goal: "Fix two bugs. Record the rest as notes." } as never;
  assert.equal(planHeadline(oldPlan), "Fix two bugs.");
  const oldReview = { summary: "Round 2 changes comments only. The code is the same." } as never;
  assert.equal(reviewHeadline(oldReview), "Round 2 changes comments only.");
});

test("a stored headline wins over the fallback", () => {
  assert.equal(planHeadline({ headline: "Short version", goal: "Long goal." } as never), "Short version");
});

test("agents must give a headline, and it has a length limit", () => {
  const plan = {
    goal: "g",
    context: "",
    acceptanceCriteria: ["a"],
    filesToTouch: [],
    steps: ["s"],
    testPlan: "",
    risks: [],
    assumptions: [],
  };
  assert.equal(PlanSchema.safeParse(plan).success, false);
  assert.equal(PlanSchema.safeParse({ ...plan, headline: "x" }).success, true);
  assert.equal(PlanSchema.safeParse({ ...plan, headline: "x".repeat(201) }).success, false);
  assert.equal(ExecutionReportSchema.safeParse({ summary: "s", deviations: [], verification: [], followUps: [] }).success, false);
  assert.equal(ReviewSchema.safeParse({ verdict: "approve", summary: "s", criteria: [], issues: [], checks: [] }).success, false);
});
