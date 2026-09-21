/**
 * Keyboard shortcuts, dispatched from the table that documents them.
 *
 * `shortcutActionsByKey` is built from `SHORTCUTS`, so a key that works but goes unlisted —
 * or a listed key that stopped working — cannot happen. The previous version claimed this
 * and did not do it: the drawer read one list and the handler was a `switch` written beside
 * it, free to drift.
 *
 * The guards each action carries are its own, not the table's: pressing `a` with a clean
 * working copy has nothing to absorb, and `u` with no checkpoint has nothing to undo. Absorb
 * and Undo are also buttons, so `actionGuards` owns those two predicates and both surfaces
 * read it — a key that works while its button is dead is a divergence, not a feature.
 */
import type { RenderModel, UICommit } from "#ui/renderModel";
import { useEffect } from "react";
import { canAbsorb, canUndo } from "../model/actionGuards.mjs";
import { commitsInOrder, findCommit } from "../model/commits.mjs";
import { shortcutActionsByKey } from "../model/shortcuts.mjs";

export type KeyboardActions = {
  model: RenderModel | null;
  selectedSha: string | null;
  onSelect: (sha: string) => void;
  onGoto: (commit: UICommit) => void;
  onAbsorb: () => void;
  onUndo: () => void;
  onRefresh: () => void;
  onToggleLog: () => void;
  onToggleShortcuts: () => void;
  onCloseTopmost: () => void;
};

export function useKeyboard(actions: KeyboardActions) {
  useEffect(() => {
    const byKey = shortcutActionsByKey();

    /**
     * Move the selection by `delta` rows, skipping the non-commit rows — the trunk tip,
     * bases, ellipses — since only commits have actions.
     */
    const moveSelection = (delta: number) => {
      const model = actions.model;
      if (!model) {
        return;
      }
      const commits = commitsInOrder(model);
      if (!commits.length) {
        return;
      }
      const current = commits.findIndex(
        commit => commit.sha === actions.selectedSha
      );
      // With nothing selected, an initial Down starts at the top and Up at the end.
      const next =
        current < 0 ? (delta > 0 ? 0 : commits.length - 1) : current + delta;
      const target = commits[Math.max(0, Math.min(commits.length - 1, next))];
      if (!target) {
        return;
      }
      actions.onSelect(target.sha);
      document
        .querySelector(`[data-sha="${target.sha}"]`)
        ?.scrollIntoView({ block: "nearest" });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // Never hijack typing: the panel holds a message editor.
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      const model = actions.model;
      if (!model) {
        return;
      }
      const action = byKey.get(event.key);
      if (!action) {
        return;
      }
      const selected = actions.selectedSha
        ? findCommit(model, actions.selectedSha)
        : null;

      switch (action) {
        case "selectAbove":
          event.preventDefault();
          moveSelection(-1);
          return;
        case "selectBelow":
          event.preventDefault();
          moveSelection(1);
          return;
        case "gotoSelected":
          if (selected && !selected.isHead) {
            event.preventDefault();
            actions.onGoto(selected);
          }
          return;
        case "absorb":
          if (canAbsorb(model)) {
            event.preventDefault();
            actions.onAbsorb();
          }
          return;
        case "undo":
          if (canUndo(model)) {
            event.preventDefault();
            actions.onUndo();
          }
          return;
        case "refresh":
          event.preventDefault();
          actions.onRefresh();
          return;
        case "toggleLog":
          event.preventDefault();
          actions.onToggleLog();
          return;
        case "toggleShortcuts":
          event.preventDefault();
          actions.onToggleShortcuts();
          return;
        case "closeTopmost":
          actions.onCloseTopmost();
          return;
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [actions]);
}
