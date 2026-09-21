/**
 * Join class names, dropping the ones that do not apply.
 *
 * Use this for anything with a branch in it, never a template literal: the class sorter rewrites
 * `` `row${isHead ? " head" : ""}` `` into `class="rowhead"`, fusing two names into one that
 * matches no rule. Arguments are out of its reach. `LEARNINGS.md` has the investigation and the
 * command that re-checks it.
 */
export function classes(
  ...parts: (string | false | null | undefined)[]
): string {
  return parts.filter(Boolean).join(" ");
}
