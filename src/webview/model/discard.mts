/**
 * What discarding a change does to the file on disk, which is what the confirmation has to say
 * before someone presses the button.
 *
 * Two outcomes, and the status letter decides. A file the commit you are on already holds goes
 * back to that version; a file only the working copy has ever held leaves the disk entirely.
 * Saying "discard" for both would be true and useless — the reader wants to know whether they
 * are about to lose an edit or a whole file.
 *
 * `A` sits with `?` rather than with the modifications, which is the one pairing worth reading
 * twice: git reports `A` for a *staged addition*, so HEAD has no version of it either, and
 * putting it back means having nothing to put.
 */

/** True when a discard deletes the file rather than restoring an earlier version of it. */
export function discardDeletesFile(status: string): boolean {
  return status === "?" || status === "A";
}

/** The consequence, phrased for the confirmation card. */
export function discardConsequence(status: string): string {
  return discardDeletesFile(status)
    ? "The file is deleted, because no commit holds a version of it yet."
    : "The file goes back to the version in the commit you are on.";
}
