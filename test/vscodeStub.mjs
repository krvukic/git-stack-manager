/**
 * A VS Code stand-in, and the compiled extension host loaded against it.
 *
 * `hosts/extension.ts` is where the panel meets the editor, and it was the only file with no
 * test at all — which is where the stale-working-copy bug lived: the host subscribed to git's
 * own writes and to nothing else, so no amount of testing the pieces underneath it would have
 * caught a file save going unnoticed. Covering it needs only the handful of API surfaces the
 * host actually touches, which is what this file provides.
 *
 * The host is a CommonJS module that `require`s `"vscode"`, a specifier no package provides —
 * VS Code injects it at run time. So it is evaluated here with a `require` that answers that
 * one specifier from this file and delegates the rest to Node, rather than through an import
 * hook that would apply to the whole suite. Every load produces a fresh instance, because the
 * host keeps the open panel in module state.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const HOST_PATH = join(PROJECT_ROOT, "out", "hosts", "extension.js");

/**
 * VS Code's `EventEmitter`, and the shape every `onDid…` in the API has: subscribing returns
 * a disposable, and the emitter's `event` is itself the subscribe function.
 *
 * @template T
 */
class Emitter {
  constructor() {
    /** @type {Set<(value: T) => void>} */
    this.listeners = new Set();
    /**
     * Extra arguments are ignored, as VS Code's own `Event` permits: the host passes
     * `(listener, null, disposables)` in one place and a bare listener everywhere else.
     *
     * @param {(value: T) => void} listener
     */
    this.event = listener => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };
  }

  /** @param {T} value */
  fire(value) {
    // A copy, so a listener that unsubscribes during delivery cannot skip the next one.
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
}

class Disposable {
  /** @param {(() => void) | undefined} [callOnDispose] */
  constructor(callOnDispose) {
    this.callOnDispose = callOnDispose;
  }

  dispose() {
    this.callOnDispose?.();
  }

  /** @param {{ dispose(): void }[]} items */
  static from(...items) {
    return new Disposable(() => {
      for (const item of items) {
        item.dispose();
      }
    });
  }
}

/**
 * @param {string} scheme
 * @param {string} fsPath
 */
function makeUri(scheme, fsPath) {
  return {
    scheme,
    fsPath,
    path: fsPath,
    query: "",
    toString: () => `${scheme}://${fsPath}`,
  };
}

/** @typedef {ReturnType<typeof makeUri>} StubUri */

/** One file system watcher, with the pattern it was created for kept for assertions. */
function createWatcher(/** @type {unknown} */ pattern) {
  /** @type {Emitter<StubUri>} */
  const change = new Emitter();
  /** @type {Emitter<StubUri>} */
  const create = new Emitter();
  /** @type {Emitter<StubUri>} */
  const remove = new Emitter();
  return {
    pattern,
    onDidChange: change.event,
    onDidCreate: create.event,
    onDidDelete: remove.event,
    dispose() {},
    /** @param {StubUri} uri */
    fireChange: uri => change.fire(uri),
    /** @param {StubUri} uri */
    fireCreate: uri => create.fire(uri),
    /** @param {StubUri} uri */
    fireDelete: uri => remove.fire(uri),
  };
}

/**
 * Everything the host asks of VS Code, plus the handles a test drives it through.
 *
 * `repositoryPath` becomes the one workspace folder, which is where the host reads the
 * repository from. `configuration` answers `workspace.getConfiguration("gsm")`.
 *
 * @param {{ repositoryPath: string, configuration?: Record<string, unknown> }} options
 */
export function createVscodeStub({ repositoryPath, configuration = {} }) {
  /** @type {Emitter<{ visible: boolean }>} */
  const treeVisibility = new Emitter();
  /** @type {Emitter<{ uri: StubUri }>} */
  const documentSaved = new Emitter();
  /** @type {Emitter<{ files: StubUri[] }>} */
  const filesCreated = new Emitter();
  /** @type {Emitter<{ files: StubUri[] }>} */
  const filesDeleted = new Emitter();
  /** @type {Emitter<{ files: { oldUri: StubUri, newUri: StubUri }[] }>} */
  const filesRenamed = new Emitter();
  /** @type {Emitter<{ focused: boolean }>} */
  const windowState = new Emitter();
  /** @type {Emitter<Record<string, never>>} */
  const terminalCommandEnded = new Emitter();
  /** @type {Emitter<undefined>} */
  const panelDisposed = new Emitter();
  /** @type {Emitter<{ webviewPanel: typeof panel }>} */
  const panelViewState = new Emitter();
  /** @type {Emitter<unknown>} */
  const messageReceived = new Emitter();

  /** @type {unknown[]} */
  const posted = [];
  /** @type {ReturnType<typeof createWatcher>[]} */
  const watchers = [];
  /** @type {Map<string, (...args: unknown[]) => unknown>} */
  const commands = new Map();
  /** @type {{ command: string, args: unknown[] }[]} */
  const executed = [];
  /** @type {string[]} */
  const terminalCommands = [];

  const panel = {
    visible: true,
    active: true,
    viewColumn: 1,
    webview: {
      html: "",
      cspSource: "vscode-webview:",
      /** @param {StubUri} uri */
      asWebviewUri: (/** @type {StubUri} */ uri) => uri,
      onDidReceiveMessage: messageReceived.event,
      /** @param {unknown} message */
      postMessage: (/** @type {unknown} */ message) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: panelDisposed.event,
    onDidChangeViewState: panelViewState.event,
    reveal() {},
    dispose() {
      panelDisposed.fire(undefined);
    },
  };

  const Uri = {
    /** @param {string} value */
    file: (/** @type {string} */ value) => makeUri("file", value),
    /**
     * @param {StubUri} base
     * @param {string[]} segments
     */
    joinPath: (/** @type {StubUri} */ base, ...segments) =>
      makeUri(base.scheme, join(base.fsPath, ...segments)),
    /** @param {string} value */
    parse: (/** @type {string} */ value) =>
      makeUri(value.split(":")[0] ?? "file", value),
  };

  const vscode = {
    ViewColumn: { One: 1 },
    FileType: { File: 1 },
    FilePermission: { Readonly: 1 },
    FileSystemError: {
      /** @param {string} message */
      NoPermissions: (/** @type {string} */ message) => new Error(message),
    },
    Uri,
    Disposable,
    EventEmitter: Emitter,
    RelativePattern: class {
      /**
       * @param {string} base
       * @param {string} pattern
       */
      constructor(base, pattern) {
        this.base = base;
        this.pattern = pattern;
      }
    },
    window: {
      createTreeView: () => ({
        onDidChangeVisibility: treeVisibility.event,
        dispose() {},
      }),
      createWebviewPanel: () => panel,
      createTerminal: () => ({
        show() {},
        /** @param {string} text */
        sendText: (/** @type {string} */ text) => terminalCommands.push(text),
      }),
      showErrorMessage: () => Promise.resolve(undefined),
      onDidChangeWindowState: windowState.event,
      onDidEndTerminalShellExecution: terminalCommandEnded.event,
    },
    workspace: {
      workspaceFolders: [{ uri: Uri.file(repositoryPath) }],
      getConfiguration: () => ({
        /** @param {string} key */
        get: (/** @type {string} */ key) => configuration[key],
      }),
      /** @param {unknown} pattern */
      createFileSystemWatcher: (/** @type {unknown} */ pattern) => {
        const watcher = createWatcher(pattern);
        watchers.push(watcher);
        return watcher;
      },
      registerFileSystemProvider: () => new Disposable(),
      onDidSaveTextDocument: documentSaved.event,
      onDidCreateFiles: filesCreated.event,
      onDidDeleteFiles: filesDeleted.event,
      onDidRenameFiles: filesRenamed.event,
    },
    commands: {
      /**
       * @param {string} command
       * @param {(...args: unknown[]) => unknown} handler
       */
      registerCommand: (command, handler) => {
        commands.set(command, handler);
        return new Disposable();
      },
      /**
       * @param {string} command
       * @param {unknown[]} args
       */
      executeCommand: (command, ...args) => {
        executed.push({ command, args });
        return Promise.resolve(undefined);
      },
    },
    env: { openExternal: () => Promise.resolve(true) },
  };

  const context = {
    /** @type {{ dispose(): void }[]} */
    subscriptions: [],
    extensionUri: Uri.file(PROJECT_ROOT),
    extensionPath: PROJECT_ROOT,
    extension: { packageJSON: { version: "0.0.0-test" } },
  };

  return {
    vscode,
    context,
    panel,
    /** Every message the host posted into the webview, oldest first. */
    posted,
    /** The refresh messages among them, which is what a re-read looks like from here. */
    refreshes: () =>
      posted.filter(
        message =>
          typeof message === "object" &&
          message !== null &&
          /** @type {{ type?: unknown }} */ (message).type === "refresh"
      ),
    watchers,
    commands,
    executed,
    terminalCommands,
    /** @param {string} filePath */
    uriFor: (/** @type {string} */ filePath) => Uri.file(filePath),
    fire: {
      /** @param {string} filePath */
      save: (/** @type {string} */ filePath) =>
        documentSaved.fire({ uri: Uri.file(filePath) }),
      /** @param {string[]} filePaths */
      created: (/** @type {string[]} */ filePaths) =>
        filesCreated.fire({ files: filePaths.map(Uri.file) }),
      /** @param {string[]} filePaths */
      deleted: (/** @type {string[]} */ filePaths) =>
        filesDeleted.fire({ files: filePaths.map(Uri.file) }),
      /**
       * @param {string} oldPath
       * @param {string} newPath
       */
      renamed: (oldPath, newPath) =>
        filesRenamed.fire({
          files: [{ oldUri: Uri.file(oldPath), newUri: Uri.file(newPath) }],
        }),
      terminalCommandEnded: () => terminalCommandEnded.fire({}),
      /** @param {boolean} focused */
      windowFocus: (/** @type {boolean} */ focused) =>
        windowState.fire({ focused }),
      /** @param {{ visible: boolean, active: boolean }} state */
      viewState: state => {
        panel.visible = state.visible;
        panel.active = state.active;
        panelViewState.fire({ webviewPanel: panel });
      },
      panelDisposed: () => panelDisposed.fire(undefined),
    },
  };
}

/** @typedef {ReturnType<typeof createVscodeStub>} VscodeStub */

/**
 * Evaluate the compiled host against a stub, and return what it exports.
 *
 * @param {VscodeStub} stub
 */
export function loadExtensionHost(stub) {
  const source = readFileSync(HOST_PATH, "utf8");
  const nodeRequire = createRequire(import.meta.url);
  const module = { exports: {} };
  const evaluate = new Function(
    "require",
    "module",
    "exports",
    "__dirname",
    "__filename",
    source
  );
  evaluate(
    /** @param {string} specifier */
    (/** @type {string} */ specifier) =>
      specifier === "vscode" ? stub.vscode : nodeRequire(specifier),
    module,
    module.exports,
    dirname(HOST_PATH),
    HOST_PATH
  );
  return /** @type {{ activate: (context: unknown) => void, deactivate: () => void }} */ (
    module.exports
  );
}

/**
 * The host, activated, with its panel open — the state every test below starts from.
 *
 * Opening goes through the registered command rather than a direct call, because that is the
 * only way in: the panel is module state the host does not export.
 *
 * @param {{ repositoryPath: string, configuration?: Record<string, unknown> }} options
 */
export function openHostPanel(options) {
  const stub = createVscodeStub(options);
  const host = loadExtensionHost(stub);
  host.activate(stub.context);
  const open = stub.commands.get("gsm.open");
  if (!open) {
    throw new Error("The host registered no gsm.open command.");
  }
  open();
  return { ...stub, host };
}
