/**
 * The lines left out of each partly chosen file, beside the ticked paths they refine.
 *
 * Kept here rather than in the overlay that edits them, so closing the overlay keeps them and the
 * sidebar's Commit… and Amend into take them. Every write keeps one rule: a choice exists only for
 * a ticked path with some of its lines left out. Leaving every line out unticks the path instead,
 * and choosing every line drops the choice, so a ticked path with no choice goes in whole.
 *
 * A choice names lines of the diff it was made on. Once that file changes on disk the numbers name
 * other lines, so after each refresh the host is asked for the current fingerprints, and a file
 * whose diff moved goes back to whole — Sapling's default — with a toast saying so. Only files with
 * a choice are asked about, so a working copy with none costs no request.
 */
import type { LineSelection } from "#history/partialSelection";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toLineSelection, type LineChoice } from "../model/lineChoice.mjs";
import { rpc } from "../rpc";
import type { Smartlog } from "./useSmartlog";

export function useLineChoices(
  smartlog: Smartlog,
  /** Runs with the paths whose choice was dropped because their diff moved. */
  onReset: (paths: string[]) => void
) {
  const { model, setPicked, toggleAllPicked, showToast } = smartlog;
  const [choices, setChoices] = useState<ReadonlyMap<string, LineChoice>>(
    () => new Map()
  );

  // Read by the refresh check below, which must run once per model and not once per click.
  const latestChoices = useRef(choices);
  useEffect(() => {
    latestChoices.current = choices;
  }, [choices]);

  useEffect(() => {
    if (!model || !latestChoices.current.size) {
      return;
    }
    const uncommitted = new Set(model.uncommitted.map(file => file.path));
    const asked = new Map(
      [...latestChoices.current].filter(([path]) => uncommitted.has(path))
    );
    let current = true;
    void rpc<Record<string, string>>("workingCopyFingerprints", {
      paths: [...asked.keys()],
    }).then(response => {
      if (!current || !response.ok) {
        return;
      }
      const fingerprints = response.data ?? {};
      const moved = [...asked]
        .filter(([path, choice]) => fingerprints[path] !== choice.fingerprint)
        .map(([path]) => path);
      setChoices(choicesNow => {
        const next = new Map<string, LineChoice>();
        for (const [path, choice] of choicesNow) {
          // A choice made while the request was in flight is newer than the answer, so only the
          // one the request asked about can be found stale.
          const stale =
            asked.get(path) === choice &&
            fingerprints[path] !== choice.fingerprint;
          if (uncommitted.has(path) && !stale) {
            next.set(path, choice);
          }
        }
        return next.size === choicesNow.size ? choicesNow : next;
      });
      if (moved.length) {
        showToast(
          `${moved.join(", ")} changed on disk, so every line of ${moved.length > 1 ? "them" : "it"} is chosen again.`,
          false
        );
        onReset(moved);
      }
    });
    return () => {
      current = false;
    };
  }, [model, onReset, showToast]);

  /** Tick or untick a whole path, which drops any lines it had left out. */
  const pickFile = useCallback(
    (path: string, picked: boolean) => {
      setPicked(path, picked);
      setChoices(current => withoutPaths(current, [path]));
    },
    [setPicked]
  );

  const toggleAll = useCallback(() => {
    toggleAllPicked();
    setChoices(current => (current.size ? new Map() : current));
  }, [toggleAllPicked]);

  /** Record which of a file's `total` changed lines are left out. */
  const setFileChoice = useCallback(
    (
      path: string,
      fingerprint: string,
      excluded: ReadonlySet<string>,
      total: number
    ) => {
      const partly = excluded.size > 0 && excluded.size < total;
      setPicked(path, excluded.size < total);
      setChoices(current => {
        const next = new Map(current);
        if (partly) {
          next.set(path, { fingerprint, excluded, total });
        } else {
          next.delete(path);
        }
        return next;
      });
    },
    [setPicked]
  );

  /** The `lines` payload for the paths an action takes. */
  const lineSelections = useCallback(
    (paths: string[]): LineSelection[] =>
      paths.flatMap(path => {
        const choice = choices.get(path);
        return choice ? [toLineSelection(path, choice)] : [];
      }),
    [choices]
  );

  /** Drop the choices an action has just committed, which no longer name uncommitted lines. */
  const forget = useCallback(
    (paths: string[]) => setChoices(current => withoutPaths(current, paths)),
    []
  );

  // One object across renders, so each file of the overlay can skip redrawing on a click in
  // another.
  const chooser = useMemo(
    () => ({ pickFile, setFileChoice }),
    [pickFile, setFileChoice]
  );

  return {
    choices,
    chooser,
    pickFile,
    toggleAll,
    setFileChoice,
    lineSelections,
    forget,
  };
}

export type LineChoices = ReturnType<typeof useLineChoices>;

function withoutPaths(
  choices: ReadonlyMap<string, LineChoice>,
  paths: string[]
): ReadonlyMap<string, LineChoice> {
  if (!paths.some(path => choices.has(path))) {
    return choices;
  }
  const next = new Map(choices);
  for (const path of paths) {
    next.delete(path);
  }
  return next;
}
