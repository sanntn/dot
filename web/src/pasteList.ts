import { MAX_BATCH } from "@dot/shared";

// One task per line. Bullets, numbers and checkboxes in front of a line are dropped, so a list pasted
// from a doc or a README works as it is.
const PREFIX = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;

export function parseList(text: string): { titles: string[]; tooMany: boolean } {
  const all = text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(PREFIX, "").trim().slice(0, 200))
    .filter((line) => line !== "");
  return { titles: all.slice(0, MAX_BATCH), tooMany: all.length > MAX_BATCH };
}
