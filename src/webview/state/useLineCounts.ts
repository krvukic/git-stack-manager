/**
 * Each drawn commit's added and removed lines, while the Config drawer asks for them.
 *
 * Kept by sha and never dropped. A sha names its content, so a count read once stays right, and
 * a refresh that redraws the same commits sends no request. Only a commit the tree has not
 * shown before, such as the result of an amend or a rebase, is asked about.
 *
 * Nothing is read while the setting is off, which is the default: the host diffs each commit to
 * count its lines, and a reader who never looks at the counts should not pay for them.
 */
import type { LineCount } from "#git/lineCounts";
import type { RenderModel } from "#ui/renderModel";
import { useEffect, useRef, useState } from "react";
import { commitsInOrder } from "../model/commits.mjs";
import { rpc } from "../rpc";

export function useLineCounts(
  model: RenderModel | null,
  enabled: boolean
): ReadonlyMap<string, LineCount> {
  const [counts, setCounts] = useState<Map<string, LineCount>>(() => new Map());
  /** Every sha already asked about, answered or still in flight. */
  const requested = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled || !model) {
      return;
    }
    const uncounted = commitsInOrder(model)
      .map(commit => commit.sha)
      .filter(sha => !requested.current.has(sha));
    if (!uncounted.length) {
      return;
    }
    for (const sha of uncounted) {
      requested.current.add(sha);
    }
    void rpc<Record<string, LineCount>>("lineCounts", { shas: uncounted }).then(
      response => {
        const answered = response.ok ? response.data : undefined;
        if (!answered) {
          // Forgotten, so the next model asks again.
          for (const sha of uncounted) {
            requested.current.delete(sha);
          }
          return;
        }
        setCounts(current => {
          const next = new Map(current);
          for (const [sha, count] of Object.entries(answered)) {
            next.set(sha, count);
          }
          return next;
        });
      }
    );
  }, [enabled, model]);

  return counts;
}
