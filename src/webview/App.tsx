/**
 * The smartlog: what the panels share, and where each one is wired up.
 *
 * Composition rather than behaviour. The repository's state lives in `useSmartlog`, and the
 * actions live in one hook per surface — `useRepositoryActions` for the top bar and the conflict
 * banner, `useCommitActions` for the tree and the commit panel, `useWorkingCopy` for the
 * uncommitted changes, `useCommitFiles` for the reads. What stays here is what no single surface
 * owns: which commit is selected, which drawer is open, how much of the command log went unseen,
 * and the sidebar's width.
 *
 * Nothing here reads the DOM to decide what to draw. That is the substance of the port: the
 * previous version rebuilt the tree with `innerHTML` on every refresh and then had to put
 * back what the rebuild destroyed — focus, the caret, a half-typed commit message, the
 * disabled state of five buttons. Those repairs are gone, along with the bugs they carried.
 */
import { useCallback, useMemo, useState } from "react";
import {
  ChangesOverlay,
  type WorkingChoosing,
} from "./components/ChangesOverlay";
import { CommandLog } from "./components/CommandLog";
import { CommitPanel } from "./components/CommitPanel";
import { ConflictBanner } from "./components/ConflictBanner";
import { ContextMenu, type MenuState } from "./components/ContextMenu";
import {
  ConfigDrawer,
  LegendDrawer,
  ShortcutsDrawer,
  type DrawerName,
} from "./components/Drawers";
import { EmptyState } from "./components/Field";
import { SplitPanel } from "./components/SplitPanel";
import { Splitter } from "./components/Splitter";
import { Toast } from "./components/Toast";
import { Tooltip } from "./components/Tooltip";
import { TopBar } from "./components/TopBar";
import { Tree } from "./components/Tree";
import { WorkingCopy } from "./components/WorkingCopy";
import { amendTargets, findCommit } from "./model/commits.mjs";
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
} from "./model/sidebarWidth.mjs";
import { rpc } from "./rpc";
import type { HostSettings } from "./settings";
import { useCommitActions } from "./state/useCommitActions";
import { useCommitFiles } from "./state/useCommitFiles";
import { commitMenuItems } from "./state/useCommitMenu";
import { useConfig } from "./state/useConfig";
import { useKeyboard } from "./state/useKeyboard";
import { useLineChoices } from "./state/useLineChoices";
import { useMergedBranchDeletion } from "./state/useMergedBranchDeletion";
import { useRepositoryActions } from "./state/useRepositoryActions";
import { useSmartlog } from "./state/useSmartlog";
import { useStoredWidth } from "./state/useStoredWidth";
import { useWorkingCopy } from "./state/useWorkingCopy";
import {
  readStoredLogHidden,
  readStoredSidebarWidth,
  storeLogHidden,
  storeSidebarWidth,
} from "./storage";

/**
 * The tree's scrolling column, shared by the loading branch and the loaded one.
 *
 * A constant rather than a component: both uses are `id="tree"` in two arms of the same render,
 * and the utilities stay legible in devtools where a wrapper would hide them.
 */
const TREE_SCROLLER = "flex-1 overflow-y-auto pt-3.5 pr-2 pb-10 pl-3.5";

export function App({ settings }: { settings: HostSettings }) {
  const smartlog = useSmartlog();
  const { model, selectedSha, setSelectedSha } = smartlog;
  const {
    config,
    update: updateConfig,
    reset: resetConfig,
    rowHeight,
  } = useConfig();

  const [openDrawer, setOpenDrawer] = useState<DrawerName | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [logHidden, setLogHidden] = useState(readStoredLogHidden);

  // Kept across loads and re-fitted to the window; the changes overlay's width works the same
  // way, through the same hook.
  const {
    width: sidebarWidth,
    requestedWidth,
    onResize: onSidebarResize,
  } = useStoredWidth({
    initial: () => readStoredSidebarWidth() ?? SIDEBAR_DEFAULT_WIDTH,
    clamp: clampSidebarWidth,
    store: storeSidebarWidth,
  });

  /**
   * The selected commit, or null when nothing is selected — *or* when what was selected no
   * longer exists, because it was folded away or replaced by a rewrite.
   *
   * Looking it up each render rather than clearing `selectedSha` in an effect. Both close the
   * panel, but the lookup closes it in the same paint that dropped the commit; an effect
   * renders once with a stale sha first, which is the frame where the panel's buttons still
   * point at a commit git no longer has.
   */
  const selectedCommit = useMemo(
    () => (model && selectedSha ? findCommit(model, selectedSha) : null),
    [model, selectedSha]
  );

  const repository = useRepositoryActions(smartlog);
  const commitActions = useCommitActions(smartlog);
  const commitFiles = useCommitFiles(smartlog);
  // A file reset while its diff is on screen is read again, so the overlay stops showing the
  // lines the reset just dropped.
  const lineChoices = useLineChoices(
    smartlog,
    commitFiles.refreshWorkingCopyChanges
  );
  const workingCopy = useWorkingCopy(smartlog, selectedCommit, lineChoices);
  const { closeChanges } = commitFiles;
  const { amendInto, openCommitForm } = workingCopy;

  const choosing = useMemo((): WorkingChoosing => {
    const uncommitted = model?.uncommitted ?? [];
    return {
      rowPaths: new Set(uncommitted.map(file => file.path)),
      pickedPaths: smartlog.pickedPaths,
      choices: lineChoices.choices,
      chooser: lineChoices.chooser,
      targets: model ? amendTargets(model) : [],
      selectedSha,
      canAct:
        !model?.conflict &&
        uncommitted.some(file => smartlog.pickedPaths.has(file.path)),
      amending: workingCopy.amending,
      // The form sits under the list the overlay covers, so the overlay makes way for it.
      onCommit: () => {
        closeChanges();
        openCommitForm();
      },
      onAmend: target =>
        void amendInto(target).then(response => {
          if (response.ok) {
            closeChanges();
          }
        }),
    };
  }, [
    amendInto,
    closeChanges,
    lineChoices.chooser,
    lineChoices.choices,
    model,
    openCommitForm,
    selectedSha,
    smartlog.pickedPaths,
    workingCopy.amending,
  ]);
  useMergedBranchDeletion(smartlog, config.deleteMergedBranches);

  const openUrl = useCallback((url: string) => {
    void rpc("openUrl", { url });
  }, []);

  /**
   * How many entries arrived while the log was hidden, so a failed action's commands stay
   * findable once its toast — which carries the message but never the commands — has timed out.
   *
   * Derived from how long the log was when it was hidden, rather than counted in an effect.
   * Counting meant a state update per entry, which is a second render for something already
   * implied by the log's own length; and the effect had to ignore `logHidden` in its
   * dependencies to avoid recounting on every toggle, which is exactly the shape that goes
   * wrong later.
   */
  const [logLengthWhenHidden, setLogLengthWhenHidden] = useState<number | null>(
    () => (readStoredLogHidden() ? 0 : null)
  );
  const unseenLogEntries =
    logLengthWhenHidden === null
      ? 0
      : Math.max(0, smartlog.log.length - logLengthWhenHidden);

  const toggleLog = useCallback(() => {
    setLogHidden(hidden => {
      const next = !hidden;
      storeLogHidden(next);
      // Hiding marks where the log had got to; showing clears the mark, which is what makes
      // the count zero again.
      setLogLengthWhenHidden(next ? smartlog.log.length : null);
      return next;
    });
  }, [smartlog.log.length]);

  const toggleDrawer = useCallback((name: string) => {
    setOpenDrawer(current => (current === name ? null : (name as DrawerName)));
  }, []);

  /**
   * Stable, so the menu's own dismissal listeners are registered once rather than on
   * every render the five-second poll causes.
   */
  const closeMenu = useCallback(() => setMenu(null), []);

  const closeTopmost = useCallback(() => {
    // Innermost first: the context menu sits over everything, then the diff overlay over
    // the split panel, which sits over the panel — so one Escape dismisses whatever is
    // actually on top rather than clearing the selection out from under it.
    if (menu) {
      closeMenu();
      return;
    }
    if (commitFiles.changes) {
      commitFiles.closeChanges();
      return;
    }
    if (commitActions.split) {
      commitActions.closeSplit();
      return;
    }
    setSelectedSha(null);
  }, [closeMenu, commitActions, commitFiles, menu, setSelectedSha]);

  useKeyboard({
    model,
    selectedSha,
    onSelect: setSelectedSha,
    onGoto: commit => void commitActions.gotoCommit(commit),
    onAbsorb: () => void workingCopy.previewAbsorb(),
    onUndo: () => void repository.undoLast(),
    onRefresh: () => void smartlog.loadModel(false, true),
    onToggleLog: toggleLog,
    onToggleShortcuts: () => toggleDrawer("keys"),
    onCloseTopmost: closeTopmost,
  });

  if (!model) {
    return (
      <>
        <div id="tree" className={TREE_SCROLLER}>
          <EmptyState>{smartlog.loadError ?? "Loading…"}</EmptyState>
        </div>
        <Toast toast={smartlog.toast} />
        <Tooltip />
      </>
    );
  }

  return (
    <>
      <TopBar
        model={model}
        version={settings.version}
        logHidden={logHidden}
        unseenLogEntries={unseenLogEntries}
        openDrawer={openDrawer}
        pullRequestsLoading={smartlog.pullRequestsLoading}
        pulling={repository.pulling}
        restacking={repository.restacking}
        onPull={() => void repository.pull()}
        onRestack={() => void repository.restack()}
        onUndo={() => void repository.undoLast()}
        onRefresh={() => void smartlog.loadModel(false, true)}
        onRefreshPullRequests={() => void smartlog.loadPullRequests(true)}
        onToggleLog={toggleLog}
        onToggleDrawer={toggleDrawer}
      />
      <div id="main" className="flex min-h-0 flex-1">
        {/* The left column stacks the tree over the command log: the log takes the bottom
            quarter, and the tree scrolls in what remains. The panel spans the full height at
            the right. `min-w-0` so a long subject shrinks the column rather than widening it. */}
        <div id="left" className="flex min-w-0 flex-1 flex-col">
          <ConflictBanner
            conflict={model.conflict}
            continuing={repository.continuing}
            onMergeTool={() => void repository.openMergeTool()}
            onContinue={() => void repository.continueRebase()}
            onAbort={() => void repository.abortRebase()}
          />
          <ConfigDrawer
            isOpen={openDrawer === "config"}
            config={config}
            onChange={updateConfig}
            onReset={resetConfig}
            onClose={() => toggleDrawer("config")}
          />
          <LegendDrawer
            isOpen={openDrawer === "legend"}
            onClose={() => toggleDrawer("legend")}
          />
          <ShortcutsDrawer
            isOpen={openDrawer === "keys"}
            onClose={() => toggleDrawer("keys")}
          />
          {/* Bottom padding well past the last row, so the deepest stack is not flush
              against the log panel and can still be scrolled clear of it. */}
          <div id="tree" className={TREE_SCROLLER}>
            {model.uncommitted.length ? (
              <WorkingCopy
                model={model}
                pickedPaths={smartlog.pickedPaths}
                choices={lineChoices.choices}
                amendTarget={selectedCommit}
                commitDraft={smartlog.commitDraft}
                commitFormOpen={workingCopy.commitFormOpen}
                committing={workingCopy.committing}
                absorbPlan={workingCopy.absorbPlan}
                absorbing={workingCopy.absorbing}
                discardTarget={workingCopy.discardTarget}
                discarding={workingCopy.discarding}
                onPick={lineChoices.pickFile}
                onToggleAll={lineChoices.toggleAll}
                onViewChanges={() => void commitFiles.showWorkingCopyChanges()}
                onChooseLines={path =>
                  void commitFiles.showWorkingCopyChanges(path)
                }
                onOpenDiff={(file, background) =>
                  void commitFiles.openWorkingCopyDiff(file, background)
                }
                onRequestDiscard={workingCopy.requestDiscard}
                onConfirmDiscard={() => void workingCopy.confirmDiscard()}
                onCancelDiscard={workingCopy.cancelDiscard}
                onDraftChange={smartlog.setCommitDraft}
                onOpenCommitForm={workingCopy.openCommitForm}
                onCancelCommitForm={workingCopy.closeCommitForm}
                onCommit={() => void workingCopy.commitPicked()}
                onAmendInto={() => void workingCopy.amendInto()}
                onPreviewAbsorb={() => void workingCopy.previewAbsorb()}
                onApplyAbsorb={() => void workingCopy.applyAbsorb()}
                onCancelAbsorb={workingCopy.closeAbsorbPlan}
              />
            ) : null}
            <Tree
              model={model}
              rowHeight={rowHeight}
              selectedSha={selectedSha}
              dimForeign={settings.onlyMyCommits}
              onSelect={commit => setSelectedSha(commit.sha)}
              onContextMenu={(event, commit) => {
                event.preventDefault();
                setSelectedSha(commit.sha);
                setMenu({
                  x: event.clientX,
                  y: event.clientY,
                  items: commitMenuItems(model, commit, {
                    onGoto: c => void commitActions.gotoCommit(c),
                    onGhStack: (payload, label) =>
                      void commitActions.runGhStack(payload, label),
                    onOpenTerminal: command =>
                      void rpc("openTerminal", { command }),
                    onSubmit: c => void commitActions.submitCommit(c),
                    onSubmitStack: c => void commitActions.submitStack(c),
                    onSplit: c => void commitActions.openSplit(c),
                    onFold: c => void commitActions.foldCommit(c),
                    onRebase: (c, destination) =>
                      void commitActions.runRebase(c, destination),
                  }),
                });
              }}
              onGoto={commit => void commitActions.gotoCommit(commit)}
              onGotoTrunk={() => void repository.gotoTrunk()}
              onGotoBranch={branch => void repository.gotoBranch(branch)}
              onOpenUrl={openUrl}
            />
          </div>
          <CommandLog
            entries={smartlog.log}
            hidden={logHidden}
            onClear={() => {
              smartlog.setLog([]);
              // The mark has to move too, or clearing while hidden leaves the button
              // counting entries that no longer exist.
              setLogLengthWhenHidden(logHidden ? 0 : null);
            }}
          />
        </div>
        <Splitter
          isOpen={Boolean(selectedCommit)}
          width={sidebarWidth}
          requestedWidth={requestedWidth}
          onResize={onSidebarResize}
        />
        {selectedCommit ? (
          <CommitPanel
            // Keyed on the sha, so a rewrite that replaces the commit remounts the panel with
            // the new one rather than leaving a dead sha on screen. See the panel's own header
            // for why the sha alone covers the message too.
            key={selectedCommit.sha}
            commit={selectedCommit}
            model={model}
            files={commitFiles.files}
            fileClick={config.fileClick}
            width={sidebarWidth}
            submitting={commitActions.submitting}
            amending={commitActions.amending}
            onAmendMessage={message =>
              void commitActions.amendMessage(selectedCommit.sha, message)
            }
            onAmendWorkingChanges={() => void workingCopy.amendWorkingChanges()}
            onGoto={() => void commitActions.gotoCommit(selectedCommit)}
            onRebase={() =>
              void commitActions.runRebase(selectedCommit, "trunk")
            }
            onSubmit={() => void commitActions.submitCommit(selectedCommit)}
            onSubmitStack={() => void commitActions.submitStack(selectedCommit)}
            onViewChanges={() =>
              void commitFiles.showChanges(selectedCommit.sha)
            }
            onOpenAllFiles={() => commitFiles.openAllFiles(selectedCommit.sha)}
            onOpenDiff={(file, background) =>
              void commitFiles.openFileDiff(
                selectedCommit.sha,
                file,
                background
              )
            }
            onOpenFile={(file, background) =>
              commitFiles.openCurrentFile(
                selectedCommit.sha,
                file.path,
                background
              )
            }
            onOpenUrl={openUrl}
          />
        ) : (
          <div id="sidebar" />
        )}
      </div>
      <SplitPanel
        split={commitActions.split}
        splitting={commitActions.splitting}
        onCancel={commitActions.closeSplit}
        onApply={(selected, firstMessage, secondMessage) =>
          void commitActions.applySplit(selected, firstMessage, secondMessage)
        }
      />
      <ChangesOverlay
        changes={commitFiles.changes}
        choosing={choosing}
        onClose={commitFiles.closeChanges}
      />
      <ContextMenu menu={menu} onClose={closeMenu} />
      <Tooltip />
      <Toast toast={smartlog.toast} />
    </>
  );
}
