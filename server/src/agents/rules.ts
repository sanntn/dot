// The project's rules, as the user accepted them, for the start of each agent's brief.
export function rulesNote(rules: string[]): string {
  if (rules.length === 0) return "";
  return [
    "# Project rules",
    "",
    "The user keeps these rules for this project. Follow them, and treat a change that breaks one as a defect.",
    "",
    ...rules.map((r) => `- ${r}`),
    "",
  ].join("\n");
}
