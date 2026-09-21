/**
 * What the host hands the webview at load, read from the document rather than
 * substituted into the script.
 *
 * The inline script used to carry `"__ONLY_MY_COMMITS__" === "true"`, which each host
 * rewrote before serving the HTML. That cannot work once the script is a separately
 * built bundle, so the hosts stamp a `data-` attribute on `<body>` instead and this
 * reads it. Same one-way flow, no round trip on startup — and unlike a token, a
 * missing attribute degrades to the documented default instead of leaving the literal
 * placeholder in a comparison.
 */
export type HostSettings = {
  /** `gsm.onlyMyCommits`: dim commits authored by somebody else. */
  onlyMyCommits: boolean;
  /**
   * The extension's version, which the top bar prints. Not a setting, but the same
   * one-way channel serves it and a second mechanism would not earn its place. The
   * webview cannot read `package.json` itself: it is a browser bundle, and reaching
   * outside `src/webview/` for a value is what the Vite config goes out of its way to
   * keep loud. Empty when no host filled it in, and the bar then prints nothing rather
   * than a bare `v`.
   */
  version: string;
};

export function readHostSettings(root: HTMLElement): HostSettings {
  return {
    onlyMyCommits: root.dataset.onlyMyCommits === "true",
    version: root.dataset.version ?? "",
  };
}
