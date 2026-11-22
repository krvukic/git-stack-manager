/**
 * The `gh stack` warning shared by every rebase toast.
 *
 * Two surfaces start a rebase — a commit's rebase entries, and Continue after a
 * conflict — each with its own success line. Only this warning is common to both, so only it
 * lives here. The host re-records the bases itself; the warning covers the rebase where that
 * repair failed.
 */

/**
 * The clause to append when a stack's recorded bases still name replaced commits, naming the
 * command that repairs each. Returns "" once the host's own re-record succeeded, which is the
 * normal outcome — so the empty string doubles as "nothing to warn about".
 */
export function staleStackNote(staleStacks: string[] | undefined): string {
  const commands = (staleStacks ?? []).map(
    bottom => `\`gh stack rebase ${bottom} --no-trunk\``
  );
  if (!commands.length) {
    return "";
  }
  return ` — gh stack still records the old bases: run ${commands.join("; ")}`;
}
