/**
 * Standalone web mode: `npm run web [-- /path/to/repo] [--port 6175]`
 * Serves the exact same UI as the VS Code webview, for use in a browser window.
 * (Same trick Sapling uses: `sl web` and the VS Code extension share one UI.)
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { renderAppHtml } from "#app/appHtml";
import { Repository } from "#app/repository";
import { errorMessage } from "#core/values";
import {
  readStringList,
  requireString,
  toActionPayload,
} from "#ui/actionPayload";
import { ActionResult, Controller } from "#ui/controller";

const DEFAULT_PORT = 6175;

/**
 * Parse `[repo] [--port N] [--no-open]`. Consuming `--port`'s value by position
 * rather than filtering it out by string keeps a repo path that happens to look
 * like the port number (`./6175`) from being mistaken for it.
 */
function parseArguments(argv: string[]): {
  repo: string;
  port: number;
  open: boolean;
} {
  let port = DEFAULT_PORT;
  let open = true;
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--port") {
      // A trailing `--port` has no value to read, which `parseInt` reports as NaN —
      // the same answer as `--port abc`, and the same message fits both.
      const value = parseInt(argv[++index] ?? "", 10);
      if (Number.isNaN(value)) {
        throw new Error("--port needs a number");
      }
      port = value;
    } else if (argument === "--no-open") {
      open = false;
    } else if (!argument.startsWith("--")) {
      positional.push(argument);
    }
  }
  return { repo: path.resolve(positional[0] ?? process.cwd()), port, open };
}

const {
  repo,
  port: PORT,
  open: shouldOpen,
} = parseArguments(process.argv.slice(2));
const controller = new Controller(new Repository(repo));
// server.js compiles to out/hosts/, so two levels reach the repo root that holds media/.
const mediaPath = path.join(__dirname, "..", "..", "media");
const htmlPath = path.join(mediaPath, "app.html");
/** Where Vite writes the webview bundle. Served at `/dist/…` to match the HTML. */
const bundlePath = path.join(mediaPath, "dist");

/**
 * The version the top bar prints, read once at startup.
 *
 * The extension host takes this from the manifest VS Code already parsed for it; nothing
 * parses one here, so this reads the file beside `media/`. An unreadable manifest degrades
 * to empty instead of throwing — the number decorates the bar, and a dev server that
 * refused to start over it would be absurd.
 */
function readVersion(): string {
  try {
    const { version } = JSON.parse(
      fs.readFileSync(path.join(mediaPath, "..", "package.json"), "utf8")
    ) as { version?: unknown };
    return typeof version === "string" ? version : "";
  } catch {
    return "";
  }
}

const VERSION = readVersion();

/**
 * Content types for what the bundle is made of, and nothing else.
 *
 * A browser refuses a stylesheet served as `text/plain` and will not execute a script
 * without a JavaScript type, so guessing is not an option; an unknown extension is
 * refused rather than sent under a default, since anything outside this list is not
 * part of the bundle.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const server = http.createServer(
  (request, response) => void handleRequest(request, response)
);

/**
 * Answer one request, reporting any throw as a 500 rather than as a rejection Node has
 * nowhere to put — `createServer` ignores what its handler returns.
 */
async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse
) {
  try {
    if (
      request.method === "GET" &&
      (request.url === "/" || request.url?.startsWith("/?"))
    ) {
      const html = renderAppHtml(htmlPath, {
        nonce: "dev",
        cspSource: "'self'",
        // Same-origin, so the bundle is reachable by path. The webview host needs an
        // absolute `vscode-webview://` URI here instead.
        baseUri: "/dist",
        version: VERSION,
        onlyMyCommits: false,
      });
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(html);
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/dist/")) {
      serveBundleFile(request.url, response);
      return;
    }
    if (request.method === "POST" && request.url?.startsWith("/api/")) {
      const action = request.url.slice("/api/".length);
      const body = await readBody(request);
      // The request body is JSON the UI built, so it decodes to an action payload; its
      // own fields are still whatever arrived, and the narrowers below check each one.
      const payload = toActionPayload(body ? JSON.parse(body) : {});
      let result: ActionResult;
      if (action === "openFile") {
        // `background` rides along from the UI and is dropped here: the system opener
        // decides what takes focus, and web mode has no tab strip to open behind.
        openWithSystem(path.join(repo, requireString(payload, "path")));
        result = { ok: true };
      } else if (action === "openFiles") {
        const paths = readStringList(payload, "paths");
        for (const filePath of paths) {
          openWithSystem(path.join(repo, filePath));
        }
        result = paths.length
          ? { ok: true }
          : { ok: false, error: "No files to open." };
      } else if (action === "openUrl") {
        openWithSystem(requireString(payload, "url"));
        result = { ok: true };
      } else if (action === "openTerminal") {
        // Web mode has no terminal to drive, so tell the user what to run.
        result = {
          ok: false,
          error: `Run this in a terminal: ${requireString(payload, "command")}`,
        };
      } else if (action === "openDiff") {
        // No editor here to host a diff. The UI reads this refusal as "show it inline"
        // and falls back to its own overlay, so the button works in both hosts.
        result = { ok: false, error: "No diff editor in web mode." };
      } else {
        result = await controller.handle(action, payload);
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result));
      return;
    }
    response.writeHead(404);
    response.end("not found");
  } catch (error: unknown) {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: errorMessage(error) }));
  }
}

/**
 * Send one file from the built bundle.
 *
 * This is the only route that maps a URL onto a filesystem path, so it is the only one
 * that can be talked into reading something else. Two things stop that: the path is
 * resolved and then checked to be inside `media/dist`, which rejects `..` however it is
 * spelled or encoded, and the extension has to be one the bundle actually contains.
 * `no-store` because the file changes on every rebuild and the page it belongs to is a
 * development tool — a cached stale bundle would look like a build that did not run.
 */
function serveBundleFile(url: string, response: http.ServerResponse) {
  // Strip any query or fragment before touching the filesystem: `app.js?v=2` is a
  // request for `app.js`, not for a file whose name contains a question mark.
  const requested = decodeURIComponent(
    new URL(url, "http://localhost").pathname
  );
  const filePath = path.resolve(
    bundlePath,
    "." + requested.slice("/dist".length)
  );
  const contentType = CONTENT_TYPES[path.extname(filePath)];
  if (!filePath.startsWith(bundlePath + path.sep) || !contentType) {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  if (!fs.existsSync(filePath)) {
    // Almost always a missing build rather than a bad URL, and the reader of this
    // message is whoever just ran the server.
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(
      `${path.basename(filePath)} is not built. Run \`just build\` (or \`bun run build:webview\`) and reload.`
    );
    return;
  }
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  response.end(fs.readFileSync(filePath));
}

/**
 * Collect a request body, refusing one larger than any action sends.
 *
 * The largest real payload is a commit message plus a path list, which is kilobytes. Without
 * a ceiling a single POST buffers until the process dies, and the reader of that crash sees a
 * dead dev server rather than a bad request. The socket is destroyed rather than drained,
 * since nothing useful follows a body this size.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    request.on("data", (chunk: Buffer | string) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new Error("Request body is too large."));
        return;
      }
      data += chunk;
    });
    request.on("end", () => resolve(data));
  });
}

/** Hand a file or URL to the desktop's default handler. */
function openWithSystem(target: string) {
  const opener = process.platform === "darwin" ? "open" : "xdg-open"; // macOS / Linux
  spawn(opener, [target], { detached: true, stdio: "ignore" }).unref();
}

// Bind to the numeric loopback address, not "localhost": Node resolves a
// hostname and binds the first address it returns, which may be IPv6 (::1).
// The VS Code / SSH port-forward targets 127.0.0.1, so an explicit IPv4 bind
// keeps the tunnel working. The displayed URL uses "localhost" for readability.
server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}/`;
  // eslint-disable-next-line no-console -- the URL to open is this program's output
  console.log(`Git Stack Manager web UI: ${url} (repo: ${repo})`);
  if (shouldOpen) {
    openWithSystem(url);
  }
});
