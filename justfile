# git-stack-manager recipes. Run `just --list` for the full set.
#
# The packaged filename is derived from package.json inside the two recipes that need it,
# not in a top-level variable. Just evaluates a backtick assignment before running any
# recipe, so a variable that reads the manifest makes every invocation depend on the
# reader being installed: `just init-repo` used to need python3 to print its own help.

# Bun has no Fedora package, so a machine without Homebrew gets the upstream installer.
# The floors are checked here because a version too old fails much later and names a git
# flag rather than a version: `for-each-ref --include-root-refs` is what git 2.44 rejects.
[doc("Install what building needs, and check the git and node version floors")]
init-repo:
    #!/usr/bin/env bash
    set -euo pipefail

    if command -v bun >/dev/null 2>&1; then
        echo "bun $(bun --version) is already installed"
    elif command -v brew >/dev/null 2>&1; then
        brew install bun
    else
        echo "No Homebrew on PATH, so installing bun from bun.sh"
        curl -fsSL https://bun.sh/install | bash
        echo 'Add "$HOME/.bun/bin" to PATH before running just build'
    fi

    missing=0
    at_least() {
        if [ "$(printf '%s\n%s\n' "$2" "$3" | sort -V | head -1)" != "$2" ]; then
            echo "$1 $3 is below the required $2"
            missing=1
        fi
    }
    if command -v git >/dev/null 2>&1; then
        at_least git 2.45 "$(git --version | cut -d' ' -f3)"
    else
        echo "git is absent, and 2.45 or newer is required"
        missing=1
    fi
    if command -v node >/dev/null 2>&1; then
        at_least node 22 "$(node --version | tr -d v)"
    else
        echo "node is absent, and 22 or newer is required"
        missing=1
    fi
    if ! command -v gh >/dev/null 2>&1; then
        echo "gh is absent, so pull request badges and gh stack actions stay off"
    fi
    if [ "$missing" != 0 ]; then
        exit 1
    fi
    echo "Ready. Next: just build"

# Install deps and compile the extension + web server + webview bundle
build:
    bun install
    bun run compile

# Package the extension as a .vsix, into dist/
package: build
    #!/usr/bin/env bash
    set -euo pipefail
    vsix="dist/git-stack-manager-$(node -p "require('./package.json').version").vsix"
    rm -rf dist && mkdir -p dist
    bunx @vscode/vsce package --no-dependencies --out "$vsix"
    echo "Packaged $vsix"

# Build the .vsix and install it into VS Code, then remind you to reload
install: package
    #!/usr/bin/env bash
    set -euo pipefail
    vsix="dist/git-stack-manager-$(node -p "require('./package.json').version").vsix"
    code --install-extension "$vsix" --force
    printf '\nInstalled. Reload the VS Code window, because a running instance keeps the old copy.\n'

# Launch a VS Code window with the extension loaded, needing no launch.json
dev: build
    code --extensionDevelopmentPath="{{source_directory()}}" --new-window

# Recompile the Node side on change during development
watch:
    bun run watch

# Run alongside `just watch`, which covers the extension host and web server. The two
# builds have separate outputs and never overlap.
[doc("Rebuild the webview bundle on change")]
watch-webview:
    bun run watch:webview

# The first pass emits rather than checking in place, because the third project, the tests
# and scripts, reads the extension's types from the `.d.ts` files beside `out/`. Checking
# the suite without them reports every `#git/*` import as untyped.
[doc("Type-check the extension host, the webview, and the tooling")]
typecheck:
    bun run typecheck

# Lint with ESLint (enforces the style guide's machine-checkable rules)
lint:
    bun run lint

# Fix what ESLint can fix automatically
lint-fix:
    bun run lint:fix

# `just canonical-classes --fix` rewrites them. Separate from `lint` because the ESLint
# plugin's version of this rule calls Tailwind without a root font size, so it never sees
# that `min-h-[110px]` is `min-h-27.5`. The editor's Tailwind extension does report it, and
# this is that check on the command line.
[doc("Report Tailwind classes that have a shorter spelling")]
canonical-classes *args:
    node scripts/canonical-classes.mjs {{args}}

# Format with Prettier, which also orders imports
format:
    bun run format

# Check formatting without rewriting anything
format-check:
    bun run format:check

# Run the integration test suite (throwaway fixture repo)
test: build
    bun run test

# Install the browser the end-to-end suite drives. Run once per machine.
init-e2e:
    bunx playwright install chromium

# Drive the real web UI against a generated demo repo, comparing DOM snapshots
test-e2e *args: build
    bunx playwright test {{args}}

# Re-record every end-to-end snapshot. Review the diff, because it is the assertion.
# `=all` rather than the bare flag: see test/e2e/fixtures/snapshot.mjs on why "changed" leaves a
# small drift in place.
test-e2e-update: build
    bunx playwright test --update-snapshots=all

# Open the HTML report from the last end-to-end run
test-e2e-report:
    bunx playwright show-report

# Everything a change has to pass: formatting, types, lint, both suites
check: format-check typecheck lint canonical-classes test test-e2e

# `check` without comparing snapshot pictures, as CI runs it
check-ci: format-check typecheck lint canonical-classes test (test-e2e "--ignore-snapshots")

# Re-record the README screenshot from the demo repository
screenshot: build
    node scripts/screenshot.mjs

# Serve the smartlog web UI for a repo (default: this repo)
web repo="." port="6175": build
    bun run web -- "{{repo}}" --port {{port}}

# State goes under the per-user runtime directory rather than /tmp. A predictable name in a
# world-writable directory lets any local account plant the pidfile that `web-bg-stop` reads
# and then kills.
[doc("Serve the web UI in the background, surviving a terminal or SSH exit")]
web-bg repo="." port="6175": build
    #!/usr/bin/env bash
    set -euo pipefail
    state="${XDG_RUNTIME_DIR:-$HOME/.cache}/git-stack-manager"
    mkdir -p "$state"
    pidfile="$state/web-{{port}}.pid"
    logfile="$state/web-{{port}}.log"
    if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
        echo "Already running on port {{port}} (pid $(cat "$pidfile")). Stop it with: just web-bg-stop {{port}}"
        exit 1
    fi
    nohup node out/hosts/server.js "{{repo}}" --port {{port}} --no-open >"$logfile" 2>&1 &
    echo $! >"$pidfile"
    sleep 1
    if ! kill -0 "$(cat "$pidfile")" 2>/dev/null; then
        echo "Server exited immediately. See $logfile:"; cat "$logfile"; rm -f "$pidfile"; exit 1
    fi
    echo "Git Stack Manager web UI: http://localhost:{{port}}/ (pid $(cat "$pidfile"))"
    echo "Logs: $logfile    Stop: just web-bg-stop {{port}}"

# Stop a backgrounded web UI started with `just web-bg`
web-bg-stop port="6175":
    #!/usr/bin/env bash
    set -euo pipefail
    pidfile="${XDG_RUNTIME_DIR:-$HOME/.cache}/git-stack-manager/web-{{port}}.pid"
    if [ ! -f "$pidfile" ]; then
        echo "No pidfile for port {{port}} ($pidfile), so nothing to stop."
        exit 0
    fi
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
        kill "$pid"
        echo "Stopped web UI on port {{port}} (pid $pid)."
    else
        echo "Process $pid is not running, so cleaning up a stale pidfile."
    fi
    rm -f "$pidfile"

# A stand-in `gh` goes first on PATH, because the demo's origin is a local bare
# repository: a real `gh pr list` there reports "no GitHub remote", so every pull
# request badge would be invisible in the one place a person clicks through. The
# canned answers are the end-to-end suite's own, so the demo cannot drift from what
# the tests assert. The shim lives in a temp directory this recipe exports PATH for,
# so neither anything outside it nor any real repository can see it.
[doc("Generate the strkit demo repo in .demo-repo/ and serve its smartlog")]
demo port="6175": build
    #!/usr/bin/env bash
    set -euo pipefail
    node scripts/make-demo-repo.mjs
    shim="$(mktemp -d)/gh-bin"
    node -e 'import("./test/e2e/fixtures/demoRepo.mjs").then((f) => f.writeStandInGitHub(process.argv[1]))' "$shim"
    export PATH="$shim:$PATH"
    bun run web -- "{{source_directory()}}/.demo-repo/work" --port {{port}}

# Depends on `build` because the generator checks the stack badges it produced back
# through the compiled reader, so a fresh clone has nothing to check against.
[doc("Regenerate the demo repo without serving it")]
demo-build: build
    node scripts/make-demo-repo.mjs
