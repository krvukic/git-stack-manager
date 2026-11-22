/**
 * What the toast reports after a stack moves onto its remote.
 *
 * The toast takes one of three shapes:
 *
 *   - some layers moved,
 *   - every layer already matched its remote,
 *   - no layer had a remote commit to move onto.
 *
 * The host supplies the reason that a layer stayed behind, so one place owns that wording rather
 * than each surface owning a copy.
 */
export type AdoptReportInput = {
  moved: string[];
  current: string[];
  skipped: { branch: string; reason: string }[];
  checkedOut: string | null;
};

export type AdoptReport = {
  text: string;
  /** Whether the toast holds something the reader has to act on. */
  warn: boolean;
};

/** "a, b and c", so the reader parses a list of layers as a sentence rather than as data. */
function andList(items: string[]): string {
  if (items.length < 2) {
    return items.join("");
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function skippedClause(skipped: AdoptReportInput["skipped"]): string {
  if (!skipped.length) {
    return "";
  }
  return ` — left ${andList(skipped.map(layer => `${layer.branch} (${layer.reason})`))}`;
}

export function adoptReport(outcome: AdoptReportInput): AdoptReport {
  const skipped = skippedClause(outcome.skipped);
  if (!outcome.moved.length) {
    if (outcome.current.length) {
      return {
        text: `Every layer already points at its remote's commit${skipped}`,
        warn: Boolean(skipped),
      };
    }
    return {
      text: `Nothing to move${skipped || " — this stack tracks no remote branches"}`,
      warn: true,
    };
  }
  const layers = `${outcome.moved.length} layer${outcome.moved.length === 1 ? "" : "s"}`;
  // `git reset` rewrote files on disk when the checkout moved, and no other part of the screen
  // reports that.
  const checkout = outcome.checkedOut
    ? `, and your files moved with ${outcome.checkedOut}`
    : "";
  return {
    text: `Moved ${layers} onto the remote${checkout}${skipped} ✓`,
    warn: Boolean(skipped),
  };
}
