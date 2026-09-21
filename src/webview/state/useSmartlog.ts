/**
 * The smartlog's state, and every action that changes it.
 *
 * One hook rather than a store: the whole UI reads one `RenderModel` and the actions all
 * do the same thing to it — run one RPC, append its command log, adopt the model it
 * returns. Nothing here reaches into the DOM, so what the previous version needed a
 * `sync…` function for (button labels, disabled states, selection counts) is now derived
 * where it is rendered.
 *
 * The working-copy selection and the commit draft still live here rather than in the
 * inputs that show them, and for the original reason: the browser host polls every five
 * seconds, so a draft held only in the DOM was destroyed mid-sentence. Keeping them in
 * state is what makes the poll invisible — React reconciles the input rather than
 * rebuilding it, so the caret no longer needs saving and restoring either.
 */
import type { FileChange } from "#git/snapshot";
import type { CommandLog } from "#ui/controller";
import type { RenderModel } from "#ui/renderModel";
import { useCallback, useEffect, useRef, useState } from "react";
import { inWebview, onHostRefresh, rpc, type RpcResult } from "../rpc";

/** How often the browser host re-reads. The webview is poked by its file watcher. */
const POLL_INTERVAL = 5_000;

export type Toast = { text: string; isError: boolean } | null;

export type LogEntry = CommandLog & { id: number };

export type SmartlogState = {
  model: RenderModel | null;
  /** Set when the first load failed and there is nothing to draw. */
  loadError: string | null;
  selectedSha: string | null;
  toast: Toast;
  log: LogEntry[];
  /** Paths the next commit or amend takes. */
  pickedPaths: Set<string>;
  commitDraft: { subject: string; body: string };
  pullRequestsLoading: boolean;
};

export function useSmartlog() {
  const [model, setModel] = useState<RenderModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [pickedPaths, setPickedPaths] = useState<Set<string>>(new Set());
  const [commitDraft, setCommitDraft] = useState({ subject: "", body: "" });
  const [pullRequestsLoading, setPullRequestsLoading] = useState(false);

  /**
   * Paths git reported as dirty at the last reconcile.
   *
   * A ref, not state: it is only read to decide whether a path is newly dirty, and making
   * it state would re-render on every poll that changed nothing.
   */
  const knownPaths = useRef<Set<string>>(new Set());
  const logId = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const pullRequestsRequested = useRef(false);

  /**
   * An error stays up longer than a success: a failure has to be readable after the eye
   * has left the button, and a confirmation does not.
   */
  const showToast = useCallback((text: string, isError = true) => {
    setToast({ text, isError });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(
      () => setToast(null),
      isError ? 8_000 : 3_000
    );
  }, []);

  /** Append the commands an action ran, skipping an action that ran none. */
  const appendLog = useCallback((entry: CommandLog | undefined) => {
    if (!entry?.commands?.length) {
      return;
    }
    setLog(entries => [...entries, { ...entry, id: ++logId.current }]);
  }, []);

  /**
   * Reconcile the selection with what git now reports.
   *
   * A path that stopped being dirty — committed, reverted, absorbed — is dropped, and a
   * newly dirty one arrives ticked. Without the drop, a stale path would be sent to
   * `commit`, which refuses anything git does not report as changed.
   *
   * The previous set is read into `known` before the ref moves, because React may run an
   * updater more than once and long after the call that queued it. An updater that read
   * `knownPaths.current` itself would see the set this call just installed, count every path
   * as already seen, and leave a file the reader started editing unticked.
   */
  const syncSelection = useCallback((uncommitted: FileChange[]) => {
    const changed = new Set(uncommitted.map(file => file.path));
    const known = knownPaths.current;
    knownPaths.current = changed;
    setPickedPaths(picked => {
      const next = new Set<string>();
      for (const path of changed) {
        // Newly dirty arrives ticked; an existing path keeps whatever it was.
        if (!known.has(path) || picked.has(path)) {
          next.add(path);
        }
      }
      return next;
    });
  }, []);

  const adoptModel = useCallback(
    (next: RenderModel) => {
      syncSelection(next.uncommitted);
      setModel(next);
    },
    [syncSelection]
  );

  /**
   * Fetch pull request status and adopt the model it returns.
   *
   * Only a full model is adopted: pull request status is an enrichment, so a malformed
   * response leaves what is on screen alone rather than blanking the tree.
   */
  const loadPullRequests = useCallback(
    async (force: boolean) => {
      setPullRequestsLoading(true);
      const response = await rpc<RenderModel>("pullRequests", { force });
      setPullRequestsLoading(false);
      if (!response.ok) {
        if (force) {
          showToast(response.error);
        }
        // The transport failed, so no model arrived to carry the outcome. Say so in the
        // header anyway, or a timeout leaves it reading as a success.
        setModel(current =>
          current
            ? {
                ...current,
                pullRequestRefresh: {
                  lastAttemptSucceeded: false,
                  lastSuccessAt:
                    current.pullRequestRefresh?.lastSuccessAt ?? null,
                  lastError: response.error,
                  fetching: false,
                },
              }
            : current
        );
        return;
      }
      if (!response.data || !Array.isArray(response.data.rows)) {
        return;
      }
      adoptModel(response.data);
      // Explain an empty result only when it was asked for, so a plain git repository
      // does not nag on every open.
      if (force && response.data.pullRequestNotice) {
        showToast(response.data.pullRequestNotice, false);
      }
    },
    [adoptModel, showToast]
  );

  const loadModel = useCallback(
    async (silent = false, shouldLog = false) => {
      const response = await rpc<RenderModel>(
        "model",
        shouldLog ? { log: true } : {}
      );
      if (!response.ok) {
        if (!silent) {
          showToast(response.error);
        }
        // Replace the placeholder so a first-load failure explains itself instead of
        // freezing; a later poll that recovers re-renders.
        setModel(current => {
          if (!current) {
            setLoadError(response.error);
          }
          return current;
        });
        return;
      }
      if (shouldLog) {
        appendLog(response.log);
      }
      setLoadError(null);
      adoptModel(response.data!);
      // Pull request status costs a ~1s `gh` round trip, so the first paint uses whatever
      // is cached and the fetch happens once, out of band, afterwards.
      if (!pullRequestsRequested.current) {
        pullRequestsRequested.current = true;
        void loadPullRequests(false);
      }
    },
    [adoptModel, appendLog, loadPullRequests, showToast]
  );

  /**
   * First paint, then keep up with the host. The browser polls; the webview is poked by the
   * extension's file watcher, which is cheaper and immediate.
   *
   * Fetching in an effect is what the lint rule warns about, and here it is the right shape
   * anyway: this is a subscription to something outside React — a git repository that changes
   * under us — not state derived from a prop. The `loaded` guard is what keeps it to one read,
   * since `loadModel`'s identity changes whenever its own dependencies do.
   *
   * `setInterval` rather than a recursive `setTimeout`, deliberately: the end-to-end suite
   * stubs `window.setInterval` before any page script runs, which is how it stops the poll
   * from landing between an action and a snapshot read. A timeout chain would slip past that
   * and reintroduce torn reads in the pictures.
   */
  const loaded = useRef(false);
  useEffect(() => {
    if (!loaded.current) {
      loaded.current = true;
      void loadModel();
    }
    if (inWebview) {
      return onHostRefresh(() => void loadModel());
    }
    const timer = setInterval(() => void loadModel(true), POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [loadModel]);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  /**
   * Run a mutating action: one RPC, its commands into the log, then the model it returns.
   *
   * `selectSha` follows the commit a rewrite produced, because every history edit
   * replaces the commit it touched — so the sha the panel was open on no longer exists,
   * and acting on it would fail with "not a local-only commit".
   */
  const runAction = useCallback(
    async <T>(
      action: string,
      payload: Record<string, unknown>,
      options: {
        onSuccess?: (data: T) => void;
        /** Model carried inside `data`, which most edits return. */
        modelFrom?: (data: T) => RenderModel | undefined;
        selectSha?: (data: T) => string | null | undefined;
        /** Re-read after a failure, since the repository may have moved anyway. */
        reloadOnError?: boolean;
      } = {}
    ): Promise<RpcResult<T>> => {
      const response = await rpc<T>(action, payload);
      appendLog(response.log);
      if (!response.ok) {
        showToast(response.error);
        if (options.reloadOnError) {
          void loadModel(true);
        }
        return response;
      }
      const data = response.data as T;
      const next = options.modelFrom?.(data);
      if (next) {
        adoptModel(next);
      }
      const sha = options.selectSha?.(data);
      if (sha !== undefined) {
        setSelectedSha(sha);
      }
      options.onSuccess?.(data);
      return response;
    },
    [adoptModel, appendLog, loadModel, showToast]
  );

  const setPicked = useCallback((path: string, picked: boolean) => {
    setPickedPaths(current => {
      const next = new Set(current);
      if (picked) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
  }, []);

  /**
   * One button for both directions: with everything ticked the only useful action is
   * clearing, and a second button would sit disabled half the time.
   */
  const toggleAllPicked = useCallback(() => {
    const paths = model?.uncommitted ?? [];
    setPickedPaths(current =>
      current.size === paths.length
        ? new Set()
        : new Set(paths.map(file => file.path))
    );
  }, [model]);

  return {
    model,
    loadError,
    selectedSha,
    setSelectedSha,
    toast,
    showToast,
    log,
    setLog,
    appendLog,
    pickedPaths,
    setPicked,
    toggleAllPicked,
    commitDraft,
    setCommitDraft,
    pullRequestsLoading,
    loadModel,
    loadPullRequests,
    runAction,
  };
}

export type Smartlog = ReturnType<typeof useSmartlog>;
