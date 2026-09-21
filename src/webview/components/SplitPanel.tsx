/**
 * Choose which of a commit's changes belong in the first of two commits.
 *
 * The remainder goes to the second, whose tree is the original — so whatever is not
 * selected is by definition what is left, and the pair ends exactly where the single commit
 * did.
 */
import { useState } from "react";
import { classes } from "../classes";
import { Button, ButtonRow } from "./Button";
import { TextInput } from "./Field";
import { Modal } from "./Modal";

export type SplitHunk = {
  id: string;
  path: string;
  startLine: number;
  removed: string[];
  added: string[];
};

export type SplitState =
  | { state: "loading"; shortSha: string }
  | {
      state: "ready";
      shortSha: string;
      subject: string;
      sha: string;
      hunks: SplitHunk[];
    }
  | null;

/** The panel's own padding, over the inset and framing `Modal` supplies. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <Modal id="split-panel" className="px-4 py-3.5">
      {children}
    </Modal>
  );
}

/** `font-bold` stated, not inherited: Tailwind's preflight resets a heading's weight. */
function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-title font-bold">{children}</h3>;
}

export function SplitPanel({
  split,
  splitting,
  onApply,
  onCancel,
}: {
  split: SplitState;
  splitting: boolean;
  onApply: (selected: string[], first: string, second: string) => void;
  onCancel: () => void;
}) {
  if (!split) {
    return <div id="split-panel" />;
  }
  if (split.state === "loading") {
    return (
      <Shell>
        <Heading>{`Split ${split.shortSha}`}</Heading>
        <div className="text-muted">Reading changes…</div>
      </Shell>
    );
  }
  /*
   * Keyed on the sha, so opening the panel on another commit remounts the form rather than
   * carrying over the previous commit's selection and messages — which would offer to split
   * one commit using hunks chosen from another.
   */
  return (
    <SplitForm
      key={split.sha}
      split={split}
      splitting={splitting}
      onApply={onApply}
      onCancel={onCancel}
    />
  );
}

function SplitForm({
  split,
  splitting,
  onApply,
  onCancel,
}: {
  split: Extract<SplitState, { state: "ready" }>;
  splitting: boolean;
  onApply: (selected: string[], first: string, second: string) => void;
  onCancel: () => void;
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [first, setFirst] = useState(`${split.subject} (part 1)`);
  const [second, setSecond] = useState(`${split.subject} (part 2)`);

  // Both commits must end up non-empty, so all-or-nothing is not a split.
  const valid = chosen.size > 0 && chosen.size < split.hunks.length;

  return (
    <Shell>
      <Heading>{`Split ${split.shortSha} — ${split.subject}`}</Heading>
      <div className="text-muted">
        Selected changes form the first commit; the rest form the second.
      </div>
      <div
        id="split-hunks"
        className="my-2 flex-1 overflow-y-auto font-[monospace] text-body"
      >
        {split.hunks.map(hunk => (
          // A chosen hunk takes the focus colour on its border and its header, so the
          // selection reads from the whole block rather than from a checkbox.
          <div
            className={classes(
              "hunk mb-2 rounded-sm border",
              chosen.has(hunk.id) ? "chosen border-accent" : "border-edge"
            )}
            key={hunk.id}
          >
            <div
              className={classes(
                "hunk-head flex cursor-pointer items-center gap-2 rounded-t-sm px-2 py-1",
                chosen.has(hunk.id) ? "bg-accent/18" : "bg-card"
              )}
              onClick={() =>
                setChosen(current => {
                  const next = new Set(current);
                  if (next.has(hunk.id)) {
                    next.delete(hunk.id);
                  } else {
                    next.add(hunk.id);
                  }
                  return next;
                })
              }
            >
              <span className="text-muted">{`${hunk.path}:${hunk.startLine}`}</span>
            </div>
            <div className="px-2 py-1 whitespace-pre-wrap">
              {hunk.removed.map((line, index) => (
                <span className="text-del" key={`del-${index}`}>
                  {`- ${line}`}
                  {index < hunk.removed.length - 1 || hunk.added.length
                    ? "\n"
                    : null}
                </span>
              ))}
              {hunk.added.map((line, index) => (
                <span className="text-add" key={`add-${index}`}>
                  {`+ ${line}`}
                  {index < hunk.added.length - 1 ? "\n" : null}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <TextInput
          className="flex-1 px-2 py-1.25 text-native-input"
          id="split-msg1"
          placeholder="First commit message"
          value={first}
          onChange={event => setFirst(event.target.value)}
        />
        <TextInput
          className="flex-1 px-2 py-1.25 text-native-input"
          id="split-msg2"
          placeholder="Second commit message"
          value={second}
          onChange={event => setSecond(event.target.value)}
        />
      </div>
      <ButtonRow className="mt-2">
        <Button
          id="split-apply"
          variant="primary"
          disabled={!valid || splitting}
          onClick={() => onApply([...chosen], first, second)}
        >
          {splitting ? "Splitting…" : "Split"}
        </Button>
        <Button id="split-cancel" onClick={onCancel}>
          Cancel
        </Button>
        <span id="split-count" className="text-muted">
          {chosen.size === split.hunks.length
            ? "Leave at least one change for the second commit"
            : `${chosen.size} of ${split.hunks.length} in the first commit`}
        </span>
      </ButtonRow>
    </Shell>
  );
}
