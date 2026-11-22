/**
 * What the toast reports after a stack's pull requests are linked on GitHub.
 *
 * The host says what the link amounted to. These functions only word it, apart from the
 * component that raises the toast, so each sentence is assertable without a tree.
 */
export type StackLinkOutcome = {
  kind: "create" | "extend" | "rebuild" | "current";
  /** The linked pull requests, bottom first. */
  pullRequests: number[];
  /** The stack an `extend` or `current` link refers to. */
  stack: number | null;
};

/** "#16, #17 and #18", so a reader parses the list as a sentence. */
function andList(pullRequests: number[]): string {
  const names = pullRequests.map(number => `#${number}`);
  if (names.length < 2) {
    return names.join("");
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function linkReport(outcome: StackLinkOutcome): string {
  const linked = andList(outcome.pullRequests);
  switch (outcome.kind) {
    case "create":
      return `Linked ${linked} as a stack ✓`;
    case "extend":
      return `Stack #${outcome.stack} now links ${linked} ✓`;
    case "rebuild":
      return `Relinked ${linked} as a stack, in the tree's order ✓`;
    case "current":
      return `GitHub already links ${linked}, as stack #${outcome.stack}`;
  }
}

/**
 * The clause Submit stack appends about the link that follows it.
 *
 * Empty when there was nothing to link, and when GitHub already linked the stack: a submit
 * that changed nothing about the link has nothing to add about it.
 */
export function submittedLinkNote(
  link: StackLinkOutcome | { error: string } | null
): { text: string; warn: boolean } {
  if (!link) {
    return { text: "", warn: false };
  }
  if ("error" in link) {
    return {
      text: ` — but linking the stack failed: ${link.error}`,
      warn: true,
    };
  }
  return {
    text: link.kind === "current" ? "" : `, and linked them as a stack`,
    warn: false,
  };
}
