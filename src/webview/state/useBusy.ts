/**
 * Which of a panel's actions is in flight, so its button can say so and refuse a second press.
 *
 * `whileBusy` owns both halves of the flag. Setting it by hand around an `await` is what
 * leaves a button dead until the next reload: an early return or a throw skips the line that
 * clears it. The keys are a union per caller, so `busy.has("subimt")` fails to compile rather
 * than reading as "not busy".
 */
import { useCallback, useState } from "react";

export function useBusy<Key extends string>() {
  const [busy, setBusy] = useState<ReadonlySet<Key>>(new Set<Key>());

  const whileBusy = useCallback(
    async <T>(key: Key, work: () => Promise<T>): Promise<T> => {
      setBusy(current => new Set(current).add(key));
      try {
        return await work();
      } finally {
        setBusy(current => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    []
  );

  return { busy, whileBusy };
}
