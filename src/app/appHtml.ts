/**
 * appHtml — fill in the placeholders of `media/app.html`.
 *
 * Both hosts serve that one document, and each has to substitute the same five values, so the
 * placeholder names live here rather than in two lists that can drift. What the hosts supply
 * differs: the webview needs a fresh nonce and an opaque `vscode-webview://` base for its
 * resources, while the dev server is same-origin and needs neither.
 *
 * The file is read per call, so editing `app.html` takes effect on the next reload rather than
 * on the next restart.
 */
import { readFileSync } from "fs";

export type AppHtmlValues = {
  /** Nonce the document's Content-Security-Policy authorises the script under. */
  nonce: string;
  /** What that policy names as the origin of local resources. */
  cspSource: string;
  /** Where the built bundle is reachable from, without a trailing slash. */
  baseUri: string;
  /** Version the top bar prints. Empty when no manifest could be read. */
  version: string;
  /** The `gsm.onlyMyCommits` setting, injected so the UI needs no round trip for it. */
  onlyMyCommits: boolean;
};

export function renderAppHtml(htmlPath: string, values: AppHtmlValues): string {
  const substitutions: Record<string, string> = {
    __NONCE__: values.nonce,
    __CSP_SOURCE__: values.cspSource,
    __BASE_URI__: values.baseUri,
    __VERSION__: values.version,
    __ONLY_MY_COMMITS__: String(values.onlyMyCommits),
  };
  // One pass over the document, and an unrecognised placeholder survives verbatim: a token
  // this list has no value for is a mismatch worth seeing in the page, not a blank.
  return readFileSync(htmlPath, "utf8").replace(
    /__[A-Z_]+__/g,
    placeholder => substitutions[placeholder] ?? placeholder
  );
}
