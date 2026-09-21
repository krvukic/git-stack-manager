/**
 * What a commit changed, and every way of looking at it: the panel's file list, one file's
 * diff, the file as it is now, and the whole-commit diff overlay. The working copy's own changes
 * travel the same paths, one read and one opener apart.
 *
 * Reads only — nothing here changes the repository, which is why it is separate from the action
 * hooks. The host decides how a diff opens: VS Code has a diff editor, the web host has none,
 * so a refusal falls back to the overlay scoped to one file. That keeps the button meaningful
 * in both hosts rather than disabled in one.
 */
import type { CommitDiff, WorkingCopyDiff } from "#git/diff";
import type { FileChange } from "#git/snapshot";
import { useCallback, useEffect, useState } from "react";
import type { ChangesState } from "../components/ChangesOverlay";
import type { FilesState } from "../components/CommitPanel";
import { findCommit } from "../model/commits.mjs";
import { rpc } from "../rpc";
import type { Smartlog } from "./useSmartlog";

export function useCommitFiles(smartlog: Smartlog) {
  const { model, selectedSha, showToast } = smartlog;
  const [files, setFiles] = useState<FilesState>({ state: "loading" });
  const [changes, setChanges] = useState<ChangesState>(null);

  /**
   * The files of whichever commit is selected.
   *
   * `current` discards a response whose selection has moved on, so a slow read for one commit
   * cannot land in the panel of another — the reason this is not simply awaited at the click.
   *
   * The lint rule objects to the `setFiles` below because a state write in an effect is
   * usually derived state that wants computing in the render instead. This is not that: it is
   * a request to the host keyed on a prop, and the "loading" write is what puts the panel in
   * that state while the round trip is in flight.
   */
  useEffect(() => {
    if (!selectedSha) {
      return;
    }
    let current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- an async read, not derived state
    setFiles({ state: "loading" });
    void rpc<FileChange[]>("files", { sha: selectedSha }).then(response => {
      if (!current) {
        return;
      }
      setFiles(
        response.ok
          ? { state: "ready", files: response.data ?? [] }
          : { state: "error", error: response.error }
      );
    });
    return () => {
      current = false;
    };
  }, [selectedSha]);

  const closeChanges = useCallback(() => setChanges(null), []);

  const showChanges = useCallback(
    async (sha: string, onlyPath: string | null = null) => {
      const commit = model ? findCommit(model, sha) : null;
      const title = onlyPath
        ? onlyPath
        : `Changes in ${commit ? commit.shortSha : sha.slice(0, 8)}`;
      setChanges({ state: "loading", title });
      const response = await rpc<CommitDiff>("commitDiff", { sha });
      if (!response.ok) {
        setChanges({ state: "error", title, error: response.error });
        return;
      }
      const all = response.data?.files ?? [];
      setChanges({
        state: "ready",
        title,
        // The sha rides along because a file the viewer can draw rather than diff — an
        // image — has to fetch its own blobs, and the diff alone does not say where from.
        sha,
        files: onlyPath ? all.filter(file => file.path === onlyPath) : all,
      });
    },
    [model]
  );

  /**
   * The same read for the changes no commit holds: the working copy against HEAD, staged changes
   * included. `onlyPath` scopes the read rather than filtering its answer, unlike `showChanges`
   * above — an untracked file is read from disk to be shown, so asking for one row must not read
   * every other one first.
   */
  const showWorkingCopyChanges = useCallback(
    async (onlyPath: string | null = null) => {
      const title = onlyPath
        ? `${onlyPath} — uncommitted`
        : "Uncommitted changes";
      setChanges({ state: "loading", title });
      const response = await rpc<WorkingCopyDiff>(
        "workingCopyDiff",
        onlyPath ? { path: onlyPath } : {}
      );
      if (!response.ok) {
        setChanges({ state: "error", title, error: response.error });
        return;
      }
      // Null where a commit's read carries a sha, which is what tells an image to fetch its
      // after side from disk.
      setChanges({
        state: "ready",
        title,
        sha: null,
        files: response.data?.files ?? [],
      });
    },
    []
  );

  /**
   * `background` asks the host for a tab that does not take focus, which is what a
   * modifier-click means; the web host has no tabs and ignores it.
   */
  const openFileDiff = useCallback(
    async (sha: string, file: FileChange, background = false) => {
      const response = await rpc("openDiff", {
        sha,
        path: file.path,
        oldPath: file.oldPath,
        background,
      });
      if (response.ok) {
        return;
      }
      await showChanges(sha, file.path);
    },
    [showChanges]
  );

  /**
   * One uncommitted change in the diff editor: HEAD's version against the file on disk. No sha
   * in the request is what says so, and the web host — which has no diff editor at all — falls
   * back to the overlay scoped to this file, exactly as a commit's diff does.
   */
  const openWorkingCopyDiff = useCallback(
    async (file: FileChange, background = false) => {
      const response = await rpc("openDiff", {
        path: file.path,
        oldPath: file.oldPath,
        background,
      });
      if (response.ok) {
        return;
      }
      await showWorkingCopyChanges(file.path);
    },
    [showWorkingCopyChanges]
  );

  const openCurrentFile = useCallback(
    (sha: string, path: string, background = false) => {
      void rpc("openFile", { path, sha, background }).then(response => {
        if (response.ok === false) {
          showToast(response.error);
        }
      });
    },
    [showToast]
  );

  /**
   * Open every file of the commit whose list is on screen, in the order the list shows them.
   *
   * The paths ride along instead of the host re-reading the commit, so the tabs are exactly the
   * rows the reader was looking at — a refresh between the read and the click would otherwise
   * open a different set from the one they clicked on. One request rather than one per file,
   * because the host opens them in sequence and a race between requests would scramble the tab
   * order.
   */
  const openAllFiles = useCallback(
    (sha: string) => {
      if (files.state !== "ready" || !files.files.length) {
        return;
      }
      void rpc("openFiles", {
        sha,
        paths: files.files.map(file => file.path),
      }).then(response => {
        if (response.ok === false) {
          showToast(response.error);
        }
      });
    },
    [files, showToast]
  );

  return {
    files,
    changes,
    closeChanges,
    showChanges,
    showWorkingCopyChanges,
    openFileDiff,
    openWorkingCopyDiff,
    openCurrentFile,
    openAllFiles,
  };
}
