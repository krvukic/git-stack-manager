/**
 * The VS Code host: opens the smartlog as an editor tab and bridges the webview.
 *
 * Everything host-specific lives here — creating the panel, injecting the nonce and
 * settings into the HTML, opening a file in a tab, launching a terminal — while every
 * git action goes through the shared `Controller`. `hosts/server.ts` is the same
 * bridge over HTTP, so the two stay behaviourally identical.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { renderAppHtml } from "#app/appHtml";
import { affectsWorkingCopy, RefreshCoalescer } from "#app/refresh";
import { Repository } from "#app/repository";
import { imageMediaType } from "#core/media";
import { errorMessage } from "#core/values";
import {
  ActionPayload,
  optionalString,
  readFlag,
  readStringList,
  requireString,
  UIRequest,
} from "#ui/actionPayload";
import { ActionResult, Controller } from "#ui/controller";
import * as vscode from "vscode";

let panel: vscode.WebviewPanel | undefined;
/**
 * The refresh subscriptions of the panel currently open, disposed with it rather than with
 * the extension: each open creates its own, and a set left behind would go on watching for a
 * panel that no longer exists.
 */
let refreshWiring: vscode.Disposable | undefined;

/**
 * Backs the activity bar view with no items. Nothing is ever drawn in it — the view
 * exists only so the activity bar has an icon to own.
 */
const LAUNCHER_PROVIDER: vscode.TreeDataProvider<never> = {
  getTreeItem(element: never): vscode.TreeItem {
    return element;
  },
  getChildren(): never[] {
    return [];
  },
};

/**
 * Turn the activity bar icon into a button that opens the smartlog.
 *
 * VS Code has no "activity bar item that runs a command" contribution: an icon there
 * owns a view container, and clicking it reveals that container. So the icon's view
 * is used as a trigger rather than a surface — becoming visible opens the editor tab
 * and immediately closes the sidebar again, which leaves one click doing one thing.
 * The alternative, a pane holding an *Open Smartlog* button, made the icon cost two
 * clicks to reach what the Source Control button reached in one.
 *
 * The sidebar has to close, not merely lose focus. Left open it shows an empty pane,
 * and the icon would stay lit as though the smartlog lived there. Closing it also
 * resets `visible` to false, which is what lets the next click fire this again.
 */
function wireActivityBarLauncher(
  context: vscode.ExtensionContext
): vscode.Disposable {
  const view = vscode.window.createTreeView("gsm.launcher", {
    treeDataProvider: LAUNCHER_PROVIDER,
  });
  const opening = view.onDidChangeVisibility(async event => {
    if (!event.visible) {
      return;
    }
    openPanel(context);
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
  });
  return vscode.Disposable.from(view, opening);
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    wireActivityBarLauncher(context),
    vscode.commands.registerCommand("gsm.open", () => openPanel(context)),
    vscode.commands.registerCommand("gsm.refresh", () =>
      panel?.webview.postMessage({ type: "refresh" })
    ),
    vscode.commands.registerCommand("gsm.submitStack", () => {
      const command =
        vscode.workspace.getConfiguration("gsm").get<string>("submitCommand") ||
        "gh stack";
      const terminal = vscode.window.createTerminal("Git Stack: submit");
      terminal.show();
      terminal.sendText(command);
    })
  );
}

function repositoryCwd(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function openPanel(context: vscode.ExtensionContext) {
  const cwd = repositoryCwd();
  if (!cwd) {
    vscode.window.showErrorMessage(
      "Git Stack Manager: open a folder that contains a git repository first."
    );
    return;
  }
  if (panel) {
    panel.reveal();
    return;
  }

  const configuration = vscode.workspace.getConfiguration("gsm");
  const trunk = configuration.get<string>("trunk") || undefined;
  const repository = new Repository(cwd, trunk);
  const controller = new Controller(repository);
  const blobProvider = registerBlobProvider(repository);

  panel = vscode.window.createWebviewPanel(
    "gsmSmartlog",
    "Git Stack",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );
  /*
   * The provider dies with the panel, not with the extension. A scheme admits one provider,
   * and this one closes over the repository the panel was opened against — so leaving it
   * registered meant the second *Open Smartlog* threw before a panel existed, and the
   * activity bar icon then did nothing at all.
   */
  panel.onDidDispose(
    () => {
      blobProvider.dispose();
      refreshWiring?.dispose();
      refreshWiring = undefined;
      panel = undefined;
    },
    null,
    context.subscriptions
  );

  // The bundle and stylesheet are files on disk, and a webview cannot load a plain
  // path: its document sits on an opaque `vscode-webview://` origin, so every local
  // resource has to be rewritten to that origin. `media/dist` is under the extension
  // root, which `localResourceRoots` covers by default, so no extra option is needed.
  const baseUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "dist")
  );
  /*
   * The version the top bar prints, taken from the manifest VS Code has already parsed —
   * no file read, and no second copy of the number to drift from it. `packageJSON` is
   * typed `any`, so the field is narrowed rather than trusted.
   */
  const { version } = context.extension.packageJSON as { version?: unknown };
  panel.webview.html = renderAppHtml(
    path.join(context.extensionPath, "media", "app.html"),
    {
      nonce: crypto.randomBytes(16).toString("hex"),
      cspSource: panel.webview.cspSource,
      baseUri: baseUri.toString(),
      version: typeof version === "string" ? version : "",
      onlyMyCommits: configuration.get<boolean>("onlyMyCommits") === true,
    }
  );

  panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    /**
     * The one place the bridge's untyped side becomes typed. Only the webview can post
     * here, and every message it sends comes from `rpc()` in `webview/rpc.ts`, so the
     * envelope is a `UIRequest`; the payload's own fields stay `unknown` and are read
     * through the `actionPayload` narrowers, since those are what the UI filled in.
     */
    const { id, action, payload } = raw as UIRequest;
    /*
     * Every call gets a reply, including the ones that throw.
     * `Controller.handle` already converts a throw into a refusal, but the host actions
     * below run outside it, and a throw there used to leave the webview's promise
     * unsettled forever — clicking a `.png` opened nothing and reported nothing, because
     * `openTextDocument` refused the bytes and the rejection had nowhere to go.
     */
    let result: ActionResult;
    try {
      result = await runHostAction(repository, controller, action, payload);
    } catch (error: unknown) {
      result = { ok: false, error: errorMessage(error) };
    }
    panel?.webview.postMessage({ id, ...result });
  });

  refreshWiring = wireRefresh(panel, cwd);
}

/**
 * Keep the panel's tree current: every VS Code event that can mean the repository moved,
 * funnelled through one coalescer.
 *
 * The ref watcher alone was the whole of this, and it only ever sees git's own writes — so
 * a commit, a checkout, and a rebase refreshed the tree while a plain file save did not.
 * That left the uncommitted list showing whatever it had held when the panel was last acted
 * on, which is the one thing a smartlog must get right.
 *
 * The signals are deliberately broader than "a file changed", because no watcher covers
 * every writer: a formatter run in the integrated terminal, a `git` command in another
 * window, an editor outside VS Code. Arriving back at the panel is what catches those, and
 * the coalescer is what keeps the resulting reads bounded — and skips them entirely while
 * the panel is off screen.
 */
function wireRefresh(
  panel: vscode.WebviewPanel,
  cwd: string
): vscode.Disposable {
  const refresh = new RefreshCoalescer(() => {
    void panel.webview.postMessage({ type: "refresh" });
  });
  const signal = () => refresh.signal();
  const signalPath = (uri: vscode.Uri) => {
    if (affectsWorkingCopy(cwd, uri.fsPath)) {
      refresh.signal();
    }
  };
  // git's own writes: HEAD moves, refs update, the index changes. Narrow by design — a
  // recursive watcher over the working tree would fire once per file a build writes, and
  // the events below already cover every edit VS Code makes.
  const refs = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(cwd, ".git/{HEAD,index,refs/**}")
  );
  return vscode.Disposable.from(
    refs,
    refs.onDidChange(signal),
    refs.onDidCreate(signal),
    refs.onDidDelete(signal),
    // A save, not a keystroke: git sees the file on disk, so an unsaved buffer is not a
    // change yet and reporting it would put a line in the tree that no action could commit.
    vscode.workspace.onDidSaveTextDocument(document =>
      signalPath(document.uri)
    ),
    vscode.workspace.onDidCreateFiles(event => event.files.forEach(signalPath)),
    vscode.workspace.onDidDeleteFiles(event => event.files.forEach(signalPath)),
    vscode.workspace.onDidRenameFiles(event => {
      for (const { oldUri, newUri } of event.files) {
        signalPath(oldUri);
        signalPath(newUri);
      }
    }),
    // A command finishing in a terminal, which is how this extension's own users move a
    // repository — `just format`, a script, `gh pr checkout`. The path is unknown, so the
    // signal is unconditional; the coalescer is what stops an `ls` from costing anything.
    vscode.window.onDidEndTerminalShellExecution(signal),
    // Focus returning to the window, for everything written while VS Code was not the
    // program in front: another editor, another terminal, a colleague's script.
    vscode.window.onDidChangeWindowState(state => {
      if (state.focused) {
        refresh.signal();
      }
    }),
    panel.onDidChangeViewState(event =>
      refresh.observe({
        visible: event.webviewPanel.visible,
        active: event.webviewPanel.active,
      })
    ),
    new vscode.Disposable(() => refresh.dispose())
  );
}

/**
 * Serves a file's contents at a commit, so the diff editor has something to read.
 *
 * VS Code's `vscode.diff` command takes two URIs and no content, so a blob that is not on
 * disk has to be reachable by URI — which is what a scheme registered here provides. The
 * same approach Source Control uses for its own `git:` URIs; a separate scheme keeps this
 * from depending on the built-in git extension being enabled.
 *
 * The sha and path travel in the query rather than the path, so a filename containing a
 * `?` or a `#` cannot corrupt the reference.
 */
const DIFF_SCHEME = "gsm-blob";

/**
 * A filesystem rather than a text-document provider, which is what the built-in git
 * extension registers for its own `git:` scheme.
 *
 * `provideTextDocumentContent` returns a string, and a string cannot carry a PNG: the bytes
 * went through a UTF-8 decode that replaced every one it could not read, so opening an image
 * from a commit produced a wall of `` rather than a picture. A filesystem provider hands
 * VS Code the bytes, and VS Code then picks the editor — the image preview for a `.png`, the
 * text editor for everything the old provider already served.
 *
 * Read-only, and every write throws: the blob is a commit's, and there is nowhere for an
 * edit to it to go.
 */
function registerBlobProvider(repository: Repository): vscode.Disposable {
  const readBlob = blobReader(repository);
  const provider: vscode.FileSystemProvider = {
    // Nothing under this scheme ever changes — a commit's blob is immutable — so the event
    // never fires and `watch` has nothing to unsubscribe.
    onDidChangeFile: new vscode.EventEmitter<vscode.FileChangeEvent[]>().event,
    watch: () => new vscode.Disposable(() => {}),
    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
      const blob = await readBlob(uri);
      return {
        type: vscode.FileType.File,
        ctime: 0,
        mtime: 0,
        size: blob.length,
        permissions: vscode.FilePermission.Readonly,
      };
    },
    readFile(uri: vscode.Uri): Promise<Uint8Array> {
      return readBlob(uri);
    },
    readDirectory: () => [],
    createDirectory() {
      throw vscode.FileSystemError.NoPermissions(DIFF_SCHEME);
    },
    writeFile() {
      throw vscode.FileSystemError.NoPermissions(DIFF_SCHEME);
    },
    delete() {
      throw vscode.FileSystemError.NoPermissions(DIFF_SCHEME);
    },
    rename() {
      throw vscode.FileSystemError.NoPermissions(DIFF_SCHEME);
    },
  };
  return vscode.workspace.registerFileSystemProvider(DIFF_SCHEME, provider, {
    isReadonly: true,
    isCaseSensitive: true,
  });
}

/**
 * The bytes one `gsm-blob` URI names, empty when that side has no such file.
 *
 * Empty rather than `FileNotFound`, because a missing side is how an addition and a deletion
 * look: the parent has no version of a new file. An empty document is what makes the diff
 * render the whole file as added or removed, and a throw here would replace that with an
 * error where the content belongs.
 *
 * VS Code stats a URI before reading it, so the bytes are memoised. They are safe to keep
 * for as long as the panel lives — the reference is a sha and a path, so the answer cannot
 * go stale — and the budget bounds what a folder of screenshots can hold onto.
 */
const BLOB_CACHE_BUDGET = 16 * 1024 * 1024;

function blobReader(
  repository: Repository
): (uri: vscode.Uri) => Promise<Uint8Array> {
  const cache = new Map<string, Uint8Array>();
  let held = 0;
  return async (uri: vscode.Uri) => {
    const parameters = new URLSearchParams(uri.query);
    const sha = parameters.get("sha");
    const filePath = parameters.get("path");
    if (!sha || !filePath) {
      return new Uint8Array();
    }
    const key = `${sha}:${filePath}`;
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }
    const blob =
      (await repository.showFileBytes(sha, filePath)) ?? Buffer.alloc(0);
    cache.set(key, blob);
    held += blob.length;
    // Oldest first, which is the order a Map iterates in, until the total fits again. The
    // entry just added is last, so it survives however large it is — evicting it would
    // mean re-reading it for the very next call.
    for (const [staleKey, value] of cache) {
      if (held <= BLOB_CACHE_BUDGET || staleKey === key) {
        break;
      }
      cache.delete(staleKey);
      held -= value.length;
    }
    return blob;
  };
}

function blobUri(sha: string, path: string, label: string): vscode.Uri {
  // The path segment is what VS Code shows in the tab and uses to pick a syntax
  // highlighter, so it keeps the real filename; the query carries the reference.
  return vscode.Uri.parse(
    `${DIFF_SCHEME}:/${path}?sha=${encodeURIComponent(sha)}&path=${encodeURIComponent(path)}&label=${encodeURIComponent(label)}`
  );
}

/**
 * A side with no content, for a file the working tree no longer holds. `blobReader` answers with
 * no bytes when the reference is absent, so leaving the sha and path off the query is the whole
 * mechanism — the alternative, `Uri.file` of a path that does not exist, makes the diff editor
 * report a missing file instead of drawing the deletion.
 */
function emptyBlobUri(path: string): vscode.Uri {
  return vscode.Uri.parse(
    `${DIFF_SCHEME}:/${path}?label=${encodeURIComponent(`${path} (deleted)`)}`
  );
}

/**
 * The actions only this host can perform, and the shared controller for the rest.
 *
 * Split out of the message listener so every one of them runs inside the listener's single
 * `try`. Each returns an `ActionResult` for the same reason the controller does: the webview
 * reads a refusal, and a host action that reported failure by showing a notification left the
 * UI believing it had worked.
 */
async function runHostAction(
  repository: Repository,
  controller: Controller,
  action: string,
  payload: ActionPayload
): Promise<ActionResult> {
  if (action === "openFile") {
    return openFileInTab(repository, {
      filePath: requireString(payload, "path"),
      sha: optionalString(payload, "sha"),
      background: readFlag(payload, "background"),
    });
  }
  if (action === "openFiles") {
    return openEveryFileInTabs(
      repository,
      readStringList(payload, "paths"),
      optionalString(payload, "sha")
    );
  }
  if (action === "openDiff") {
    return openDiffEditor(repository, {
      sha: optionalString(payload, "sha"),
      filePath: optionalString(payload, "path"),
      oldPath: optionalString(payload, "oldPath"),
      background: readFlag(payload, "background"),
    });
  }
  if (action === "openCommitChanges") {
    return openCommitChanges(repository, requireString(payload, "sha"));
  }
  if (action === "openTerminal") {
    // An interactive TUI cannot run inside the webview, so give it a terminal.
    const terminal = vscode.window.createTerminal("Git Stack");
    terminal.show();
    terminal.sendText(requireString(payload, "command"));
    return { ok: true };
  }
  if (action === "openUrl") {
    await vscode.env.openExternal(
      vscode.Uri.parse(requireString(payload, "url"))
    );
    return { ok: true };
  }
  return controller.handle(action, payload);
}

/**
 * Open one file's diff: for a commit, its parent's version on the left and the commit's on the
 * right; with no sha, HEAD's version against the file on disk. A refusal sends the caller to the
 * inline overlay instead.
 *
 * The checked-out commit's right side is the file on disk rather than its blob, so the diff stays
 * editable, as the working-copy diff does. The disk holds that commit plus whatever is
 * uncommitted, so an uncommitted edit shows in this diff too: an edit made here lands there
 * regardless, and a blob would hide it.
 *
 * An image is refused, because the diff editor cannot show one. VS Code draws a `.png`
 * through the *media-preview* extension's custom editor, and a diff editor hosts only text
 * editors — so a picture on each side came out as the placeholder about a file that "is
 * either binary or uses an unsupported text encoding". The overlay draws both versions, so
 * that is where an image belongs. Every other binary keeps the placeholder: it at least
 * offers to open the file anyway, which is more than the overlay's note does.
 */
async function openDiffEditor(
  repository: Repository,
  {
    sha,
    filePath,
    oldPath,
    background,
  }: {
    sha: string | undefined;
    filePath: string | undefined;
    oldPath: string | undefined;
    background: boolean;
  }
): Promise<ActionResult> {
  if (!filePath) {
    return { ok: false, error: "No file to diff." };
  }
  if (imageMediaType(filePath)) {
    return { ok: false, error: "The diff editor cannot show an image." };
  }
  // A rename's left side is the old path, or the diff would compare against a file that
  // did not exist under this name yet.
  const previousPath = oldPath ?? filePath;
  if (!sha) {
    return openWorkingCopyDiff(repository, {
      filePath,
      previousPath,
      background,
    });
  }
  const short = sha.slice(0, 8);
  const left = blobUri(`${sha}^`, previousPath, `${previousPath} (parent)`);
  const right = commitRightSide(
    repository,
    sha,
    filePath,
    await isCheckedOut(repository, sha)
  );
  await vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right.uri,
    right.editable
      ? `${filePath} — working copy against ${short}'s parent`
      : `${filePath} — ${short} against its parent`,
    { preview: false, preserveFocus: background }
  );
  return { ok: true };
}

/**
 * Every file of the checked-out commit in VS Code's multi-file diff editor, the view Source
 * Control's own "View changes" opens. The right sides are the files on disk, so each one is
 * editable, which the overlay cannot offer.
 *
 * Any other commit is refused, and the caller shows the overlay instead: its files exist only
 * as blobs, and the overlay draws those as well as this editor does. So does an empty commit,
 * whose overlay says there is nothing to show where this editor would open blank.
 */
async function openCommitChanges(
  repository: Repository,
  sha: string
): Promise<ActionResult> {
  if (!(await isCheckedOut(repository, sha))) {
    return {
      ok: false,
      error: "Only the checked-out commit opens in the multi-diff editor.",
    };
  }
  const files = await repository.filesForCommit(sha);
  if (!files.length) {
    return { ok: false, error: "The commit changes no files." };
  }
  const short = sha.slice(0, 8);
  const resources = files.map(file => {
    const previousPath = file.oldPath ?? file.path;
    return [
      vscode.Uri.file(path.join(repository.git.cwd, file.path)),
      blobUri(`${sha}^`, previousPath, `${previousPath} (parent)`),
      commitRightSide(repository, sha, file.path, true).uri,
    ];
  });
  await vscode.commands.executeCommand(
    "vscode.changes",
    `Changes in ${short} — working copy against its parent`,
    resources
  );
  return { ok: true };
}

/**
 * A commit's side of its diff: the file on disk when the commit is checked out, so the diff is
 * editable, and the commit's blob otherwise. A file deleted since the commit leaves nothing on
 * disk to edit, so the blob stays.
 */
function commitRightSide(
  repository: Repository,
  sha: string,
  filePath: string,
  checkedOut: boolean
): { uri: vscode.Uri; editable: boolean } {
  const absolutePath = path.join(repository.git.cwd, filePath);
  if (checkedOut && fs.existsSync(absolutePath)) {
    return { uri: vscode.Uri.file(absolutePath), editable: true };
  }
  return {
    uri: blobUri(sha, filePath, `${filePath} (${sha.slice(0, 8)})`),
    editable: false,
  };
}

/**
 * Whether `sha` names the commit HEAD points at. One `rev-parse` resolves both, so an abbreviated
 * sha compares by the commit it names rather than by its text.
 */
async function isCheckedOut(
  repository: Repository,
  sha: string
): Promise<boolean> {
  const resolved = await repository.git.tryRun([
    "rev-parse",
    "HEAD",
    `${sha}^{commit}`,
  ]);
  const [head, commit] = resolved?.split("\n") ?? [];
  return Boolean(head) && head === commit;
}

/**
 * One uncommitted change in the diff editor: HEAD's version on the left, the file itself on the
 * right.
 *
 * The right side is the working file rather than a blob, so it stays editable — a typo noticed
 * while reading the diff is fixed where it is, which is what Source Control's own change editor
 * offers. Two shapes need naming: a path git reports as a whole folder of new files is refused,
 * since the diff editor takes one file, and a file the working tree no longer holds gets an empty
 * right side so the deletion reads as every line removed.
 */
async function openWorkingCopyDiff(
  repository: Repository,
  {
    filePath,
    previousPath,
    background,
  }: { filePath: string; previousPath: string; background: boolean }
): Promise<ActionResult> {
  if (filePath.endsWith("/")) {
    return {
      ok: false,
      error: `${filePath} is a folder of new files, and the diff editor takes one file.`,
    };
  }
  const absolutePath = path.join(repository.git.cwd, filePath);
  const left = blobUri("HEAD", previousPath, `${previousPath} (HEAD)`);
  const right = fs.existsSync(absolutePath)
    ? vscode.Uri.file(absolutePath)
    : emptyBlobUri(filePath);
  await vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right,
    `${filePath} — working copy against HEAD`,
    { preview: false, preserveFocus: background }
  );
  return { ok: true };
}

/**
 * Open a file the way double-clicking it in the explorer would.
 *
 * `vscode.open` rather than `showTextDocument`, so VS Code chooses the editor: the image
 * preview for a `.png`, the text editor for source, the "open anyway" placeholder for
 * anything else. Forcing the text editor is what made clicking a `.png` in the file list do
 * nothing — `openTextDocument` rejected the bytes, and the rejection reached no one.
 *
 * `background` leaves the smartlog focused, which is what a modifier-click asks for. It maps
 * onto `preserveFocus`, and only focus moves: the tab still opens, still pinned, still in the
 * active group.
 */
async function openFileInTab(
  repository: Repository,
  {
    filePath,
    sha,
    background,
  }: { filePath: string; sha: string | undefined; background: boolean }
): Promise<ActionResult> {
  const absolutePath = path.join(repository.git.cwd, filePath);
  if (fs.existsSync(absolutePath)) {
    await vscode.commands.executeCommand(
      "vscode.open",
      vscode.Uri.file(absolutePath),
      { preview: false, preserveFocus: background }
    );
    return { ok: true };
  }
  // The file left the working tree — deleted or renamed later in the stack — so show the
  // blob from the commit that still has it. Existence is checked first: opening the URI
  // regardless would present an empty editor as though the file were empty.
  if (sha && (await repository.showFileBytes(sha, filePath))) {
    await vscode.commands.executeCommand(
      "vscode.open",
      blobUri(sha, filePath, `${filePath} (${sha.slice(0, 8)})`),
      { preview: false, preserveFocus: background }
    );
    return { ok: true };
  }
  return {
    ok: false,
    error: `${filePath} is not in the working tree, and the commit has no version of it.`,
  };
}

/** How many unopened paths a refusal names before it counts the rest instead. */
const NAMED_FAILURES = 3;

/**
 * Open every file of one commit, each in a tab that keeps focus where it is.
 *
 * Sequential rather than concurrent, because the tab strip orders tabs by when each editor
 * opened: awaiting them together would hand the reader the panel's list in an order decided by
 * how fast each file read. Every path is attempted even after one fails, and a deleted file is
 * the common failure rather than a rare one — a commit that renames a file leaves the old path
 * absent from both the working tree and later commits.
 */
async function openEveryFileInTabs(
  repository: Repository,
  paths: string[],
  sha: string | undefined
): Promise<ActionResult> {
  if (!paths.length) {
    return { ok: false, error: "No files to open." };
  }
  const failed: string[] = [];
  for (const filePath of paths) {
    // A throw here is a single file VS Code would not open, and the remaining tabs are still
    // worth opening — an uncaught one would abandon them and report nothing about either.
    const result = await openFileInTab(repository, {
      filePath,
      sha,
      background: true,
    }).catch((error: unknown) => ({
      ok: false as const,
      error: errorMessage(error),
    }));
    if (!result.ok) {
      failed.push(filePath);
    }
  }
  if (!failed.length) {
    return { ok: true };
  }
  const named = failed.slice(0, NAMED_FAILURES).join(", ");
  const rest =
    failed.length > NAMED_FAILURES
      ? ` and ${failed.length - NAMED_FAILURES} more`
      : "";
  // "Could not open" rather than the single-file wording about the working tree and the commit:
  // a path lands here both when neither side holds it and when the editor rejected the bytes,
  // and the tally cannot tell which happened to any one of them.
  return {
    ok: false,
    error: `Opened ${paths.length - failed.length} of ${paths.length} files. Could not open ${named}${rest}.`,
  };
}

export function deactivate() {}
