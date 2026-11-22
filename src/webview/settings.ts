/**
 * What the host hands the webview at load, read from the document rather than
 * substituted into the script.
 *
 * The script is a separately built bundle, which no host can rewrite before serving it, so
 * the hosts stamp a `data-` attribute on `<body>` instead and this reads it. One-way flow,
 * no round trip on startup — and unlike a token, a missing attribute degrades to the
 * documented default instead of leaving the literal placeholder in a comparison.
 */
export type HostSettings = {
  /**
   * The extension's version, which the top bar prints. The webview cannot read
   * `package.json` itself: it is a browser bundle, and reaching outside `src/webview/` for
   * a value is what the Vite config goes out of its way to keep loud. Empty when no host
   * filled it in, and the bar then prints nothing rather than a bare `v`.
   */
  version: string;
};

export function readHostSettings(root: HTMLElement): HostSettings {
  return {
    version: root.dataset.version ?? "",
  };
}
