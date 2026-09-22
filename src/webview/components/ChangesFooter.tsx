/**
 * What the chosen lines can become, from inside the overlay they were chosen in.
 *
 * The overlay covers the tree, which is where a commit is selected, so the amend destination is
 * picked here instead: HEAD and each commit below it, starting at the commit selected in the tree
 * when it is one of them. Both buttons take every ticked change, the same set the sidebar's
 * buttons take, including files this overlay was not opened on.
 */
import type { UICommit } from "#ui/renderModel";
import { useState } from "react";
import { truncate } from "../model/commits.mjs";
import { Button } from "./Button";

export type ChosenCount = {
  files: number;
  pickedFiles: number;
  lines: number;
  chosenLines: number;
};

function describeCount(count: ChosenCount): string {
  const files = `${count.pickedFiles} of ${count.files} file${count.files > 1 ? "s" : ""}`;
  return count.lines
    ? `${files}, ${count.chosenLines} of ${count.lines} line${count.lines > 1 ? "s" : ""} chosen`
    : `${files} chosen`;
}

export function ChangesFooter({
  count,
  targets,
  selectedSha,
  canAct,
  amending,
  onCommit,
  onAmend,
}: {
  count: ChosenCount;
  /** HEAD first, then each commit below it that an amend can write to. */
  targets: UICommit[];
  /** The commit selected in the tree, which the picker starts on when it can. */
  selectedSha: string | null;
  /** False with nothing ticked, or while a conflict blocks every write. */
  canAct: boolean;
  amending: boolean;
  onCommit: () => void;
  onAmend: (target: UICommit) => void;
}) {
  const [pickedSha, setPickedSha] = useState(selectedSha);
  // A rewrite replaces every sha above the one it touched, so a stale pick falls back rather
  // than naming a commit that no longer exists.
  const target =
    targets.find(commit => commit.sha === pickedSha) ??
    targets.find(commit => commit.sha === selectedSha) ??
    targets[0];

  return (
    <div
      id="changes-footer"
      className="flex flex-none flex-wrap items-center gap-2 border-t border-t-edge px-3 py-2 text-body"
    >
      <span id="changes-count" className="flex-1 text-meta text-muted">
        {describeCount(count)}
      </span>
      <Button
        size="small"
        id="btn-changes-commit"
        disabled={!canAct}
        title="Commit every ticked change as a new commit on top, in the form under the list"
        onClick={onCommit}
      >
        Commit…
      </Button>
      <Button
        size="small"
        id="btn-changes-amend"
        disabled={!canAct || !target || amending}
        title={
          target
            ? `Fold every ticked change into “${target.subject}”, keeping its message`
            : "HEAD is not a local commit, so there is nothing to amend into"
        }
        onClick={() => target && onAmend(target)}
      >
        {amending ? "Amending…" : "Amend into"}
      </Button>
      <select
        id="changes-amend-target"
        aria-label="The commit to amend into"
        className="max-w-72 rounded-sm border border-input-edge bg-input px-1.5 py-0.5 font-[inherit] text-body/auto text-input-fg"
        disabled={!target}
        value={target?.sha ?? ""}
        onChange={event => setPickedSha(event.target.value)}
      >
        {targets.map(commit => (
          <option key={commit.sha} value={commit.sha}>
            {`${commit.isHead ? "HEAD" : commit.shortSha} — ${truncate(commit.subject, 48)}`}
          </option>
        ))}
      </select>
    </div>
  );
}
