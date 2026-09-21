/**
 * Transport bridge: VS Code webview messages, or plain HTTP.
 *
 * One `rpc(action, payload)` for both hosts, so nothing above this file knows which it is
 * running in. The webview posts a message and waits for the reply carrying its id; the
 * browser posts to `/api/<action>`.
 *
 * Every call resolves — none rejects. A dead server, a dropped SSH tunnel, or a stalled
 * request must not hang the UI or surface as an unhandled rejection, so a timeout caps
 * every HTTP call and any network or parse failure is normalised to the `{ok: false}`
 * shape the callers already handle. Without that, a rejected fetch left the page sitting
 * on "Loading…" with no hint.
 */
import type { UIRequest } from "#ui/actionPayload";
import type { CommandLog } from "#ui/controller";

/** The reply shape both hosts answer with, mirroring `ActionResult`. */
export type RpcResult<T = unknown> =
  | { ok: true; data?: T; log?: CommandLog }
  | { ok: false; error: string; log?: CommandLog };

/**
 * Everything the extension host posts into the webview: a reply carrying the `id` of
 * the call still waiting for it, or an unsolicited poke to re-read.
 *
 * `type` is declared on both arms, absent on a reply, so reading it discriminates them
 * without a `in` test that a stray non-object message would throw on.
 */
type HostMessage =
  | { type: "refresh"; id?: undefined }
  | (RpcResult & { type?: undefined; id: number });

/** How long an HTTP call may take before it is reported as unreachable. */
const HTTP_TIMEOUT = 15_000;

type VsCodeApi = {
  postMessage(message: unknown): void;
};

declare function acquireVsCodeApi(): VsCodeApi;

const vscode: VsCodeApi | null =
  typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;

/** True in the VS Code webview, false in a browser. The poll below is browser-only. */
export const inWebview = vscode !== null;

const pendingCalls = new Map<number, (result: RpcResult) => void>();
let sequence = 0;

if (vscode) {
  window.addEventListener("message", event => {
    /**
     * `event.data` is `any`, and this is where the shape is decided for everything
     * below. Only the extension host can post into a webview — the page's CSP admits
     * no other frame, and `postMessage` from elsewhere cannot reach the
     * `vscode-webview://` origin — so the envelope is whatever `hosts/extension.ts`
     * sent, which is one of the two `HostMessage` arms.
     */
    const message = event.data as HostMessage | undefined;
    if (message?.type === "refresh") {
      for (const listener of refreshListeners) {
        listener();
      }
      return;
    }
    if (!message) {
      return;
    }
    const resolve = pendingCalls.get(message.id);
    if (resolve) {
      pendingCalls.delete(message.id);
      resolve(message);
    }
  });
}

/**
 * The host asking the UI to re-read, which the extension sends when git state changes —
 * HEAD moves, refs update, the index changes. Listeners rather than a single callback so
 * a component can subscribe and unsubscribe with its own lifetime.
 */
const refreshListeners = new Set<() => void>();

export function onHostRefresh(listener: () => void): () => void {
  refreshListeners.add(listener);
  return () => refreshListeners.delete(listener);
}

export function rpc<T = unknown>(
  action: string,
  payload: Record<string, unknown> = {}
): Promise<RpcResult<T>> {
  if (vscode) {
    return new Promise(resolve => {
      const id = ++sequence;
      pendingCalls.set(id, resolve as (result: RpcResult) => void);
      const request: UIRequest = { id, action, payload };
      vscode.postMessage(request);
    });
  }
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), HTTP_TIMEOUT);
  return fetch(`/api/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: abortController.signal,
  })
    .then(response => response.json() as Promise<RpcResult<T>>)
    .catch((error: unknown): RpcResult<T> => ({
      ok: false,
      error:
        error instanceof Error && error.name === "AbortError"
          ? "Server did not respond within 15s — is `just web` still running?"
          : "Cannot reach the server. It may have stopped; restart `just web` and refresh.",
    }))
    .finally(() => clearTimeout(timer));
}
