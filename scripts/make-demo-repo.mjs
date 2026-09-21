/**
 * Generate the "strkit" demo repository: a self-contained git history that
 * exercises every render path in the smartlog. Run via `just demo`, which serves
 * its smartlog.
 *
 * Every branch below exists to produce one state the UI draws differently, and
 * each comment names that state. Between them they cover every sync badge
 * `model/badges.mts` can emit, both `gh stack` badge states, a teammate's commit
 * on a shared branch, and a rebase that stops on a conflict:
 *
 *   submitted        case-utils           Pushed, and unchanged since
 *   N unsubmitted    trim-utils           Pushed, then one more local commit on top
 *   not submitted    escape-html          Never pushed
 *   N behind         wrap-lines           A teammate's commit is on the remote but not here
 *   diverged N↑M↓    fix-slugify-unicode  Amended after pushing, without a force push
 *   upstream gone    normalize-quotes     Pushed, then the remote branch deleted as if merged
 *
 * The shapes matter as much as the badges: a multi-commit stack with branch
 * pointers mid-chain (case-utils → pad-utils → trim-utils), a stack that forks
 * (parse-utils into parse-numbers and parse-dates), which is the case needing one
 * rebase per leaf, and local `main` left behind `origin/main`, the state of a
 * repository fetched but never pulled.
 *
 * A live .git cannot be committed into this repo, so the demo is generated on
 * demand into a scratch directory. The bare "origin.git" beside it makes the
 * local/remote divergence real without any network.
 *
 * The tests share the git-building primitives in `git-fixture.mjs` but keep their
 * own topologies, so the demo can grow richer without touching any assertion.
 * Every commit goes through a pinned clock and identity, so regenerating the demo
 * reproduces the same shas — which is what lets the end-to-end snapshots
 * photograph them.
 *
 * Usage: node scripts/make-demo-repo.mjs [destination]   (default: .demo-repo)
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  amendFile,
  commitFile,
  initRepoWithOrigin,
  OTHER,
  run,
  writeGhStackState,
} from "./git-fixture.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(process.argv[2] ?? join(repoRoot, ".demo-repo"));
const require = createRequire(import.meta.url);

if (existsSync(destination)) {
  rmSync(destination, { recursive: true, force: true });
}
mkdirSync(destination, { recursive: true });

const { repo } = initRepoWithOrigin(destination);
const checkout = (/** @type {string} */ ref) =>
  run(repo, "git", ["switch", ref]);
const detach = (/** @type {string} */ sha) =>
  run(repo, "git", ["switch", "--detach", sha]);
const branch = (/** @type {string} */ name) =>
  run(repo, "git", ["switch", "-c", name]);
const push = (/** @type {string[]} */ ...args) =>
  run(repo, "git", ["push", ...args]);

/**
 * Fail the build unless the extension reads back the stack badges this fixture set
 * out to produce.
 *
 * `.git/gh-stack` is written here by hand, because a fixture every machine has to
 * build cannot depend on a preview `gh` extension being installed. The cost is that
 * the private format is now hard-coded in a second place, and a `gh stack` that
 * moved to schemaVersion 2 would make `readGhStacks` return nothing — badges would
 * simply vanish, and the only symptom would be a snapshot diff someone might
 * re-record without reading. Asserting the expected badges here turns that into a
 * generator that refuses to run, naming the mismatch.
 *
 * `test/gh-stack.test.mjs` covers the other half: it compares this module's derived
 * `needsRebase` against `gh stack view --json` whenever the extension is present,
 * so the two together catch both a format that moved and a verdict that drifted.
 *
 * @param {string} repository
 * @param {Record<string, string>} expected
 */
function verifyStackBadges(repository, expected) {
  const { readGhStacks, indexStackMembership } = require(
    join(repoRoot, "out", "github", "ghStack.js")
  );
  const shaOfBranch = new Map(
    run(repository, "git", [
      "for-each-ref",
      "--format=%(refname:short) %(objectname)",
      "refs/heads",
    ])
      .split("\n")
      .filter(Boolean)
      .map(line => /** @type {[string, string]} */ (line.split(" ")))
  );
  const membership = indexStackMembership(
    readGhStacks(join(repository, ".git")),
    shaOfBranch
  );
  const actual = Object.fromEntries(
    [...membership].map(([name, { position, size, needsRebase }]) => [
      name,
      `${position}/${size}${needsRebase ? " needs rebase" : ""}`,
    ])
  );
  const problems = [
    ...new Set([...Object.keys(expected), ...Object.keys(actual)]),
  ]
    .filter(name => expected[name] !== actual[name])
    .map(
      name =>
        `  ${name}: expected ${expected[name] ?? "no badge"}, got ${actual[name] ?? "no badge"}`
    );
  if (problems.length) {
    throw new Error(
      `The gh stack badges this demo produces are not the ones it intends:\n${problems.join("\n")}\n\n` +
        "Most likely `gh stack` changed the format of .git/gh-stack, which SUPPORTED_SCHEMA_VERSION in\n" +
        "src/github/ghStack.ts then rejects. Compare `gh stack view --json` against that module and\n" +
        "update both it and `writeGhStackState` in scripts/git-fixture.mjs."
    );
  }
}

// Trunk: the strkit scaffold, and a few utilities other people shipped.
commitFile(
  repo,
  "README.md",
  "# strkit\n\nTiny string utilities.\n",
  "Initial commit: strkit scaffold",
  OTHER
);
commitFile(
  repo,
  "src/slugify.js",
  "export const slugify = (s) => s.toLowerCase().replace(/\\s+/g, '-');\n",
  "feat: add slugify",
  OTHER
);
commitFile(
  repo,
  "src/truncate.js",
  "export const truncate = (s, n) => s.length > n ? s.slice(0, n) + '…' : s;\n",
  "feat: add truncate",
  OTHER
);
commitFile(
  repo,
  "test/slugify.test.js",
  "// covers basic slugify cases\n",
  "test: cover slugify basics",
  OTHER
);
push("-u", "origin", "main");
const trunkBaseline = run(repo, "git", ["rev-parse", "HEAD"]);

// A bugfix branch amended after review, then more trunk work.
// fix-slugify-unicode: pushed, then amended without a force push, so origin holds
// a commit this branch no longer has and vice versa — the "diverged 1↑1↓" badge.
branch("fix-slugify-unicode");
commitFile(
  repo,
  "src/slugify.js",
  "export const slugify = (s) => s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/\\s+/g, '-');\n",
  "fix(slugify): strip diacritics so accented input slugifies"
);
commitFile(
  repo,
  "test/slugify.test.js",
  "// covers basic slugify cases\n// covers accented input\n",
  "fix(slugify): strip diacritics so accented input slugifies"
);
push("-u", "origin", "fix-slugify-unicode");
amendFile(
  repo,
  "test/slugify.test.js",
  "// covers basic slugify cases\n// covers accented input\n// covers input that is already decomposed\n",
  "fix(slugify): strip diacritics, and cover decomposed input"
);

// wip-titlecase: never pushed — pure local work-in-progress off the same base.
// Its second commit edits two separate regions of the sketch, which makes it the
// one commit here with more than one hunk — the only kind Split can take apart.
detach(trunkBaseline);
branch("wip-titlecase");
commitFile(
  repo,
  "src/titlecase.js",
  [
    "// TODO: sketch titleCase",
    "export const titleCase = (s) => s",
    "  .split(' ')",
    "  .map((w) => w[0].toUpperCase() + w.slice(1))",
    "  .join(' ');",
    "",
  ].join("\n"),
  "wip(case): sketch titleCase (do not push)"
);
commitFile(
  repo,
  "src/titlecase.js",
  [
    "// TODO: small-word handling (a, the, of)",
    "export const titleCase = (s) => s",
    "  .split(' ')",
    "  .map((w) => w[0].toUpperCase() + w.slice(1))",
    "  .join(' ')",
    "  .trim();",
    "",
  ].join("\n"),
  // The one commit here with a body, so the sidebar's description editor has something
  // to show — and something for the fit-to-content grip to expand into.
  [
    "wip(case): note small-word handling TODO",
    "",
    "Title case should leave short joining words alone, which this does not do yet.",
    "The exceptions list is the fiddly part: it differs per style guide, and the",
    "first and last word always capitalise regardless of what is in it.",
    "",
    "Left as a TODO rather than guessed at, so the branch stays reviewable.",
  ].join("\n")
);

// A deep stack, case → pad, carrying branch pointers mid-chain.
// case-utils and pad-utils are pushed and in sync; the stack continues past
// pad-utils with unpushed commits, so trim-utils ends up ahead of its remote.
detach(trunkBaseline);
branch("case-utils");
commitFile(
  repo,
  "src/case.js",
  "export const camelCase = (s) => s;\n",
  "feat(case): add camelCase"
);
commitFile(
  repo,
  "src/case.js",
  "export const camelCase = (s) => s;\nexport const snakeCase = (s) => s;\n",
  "feat(case): add snakeCase"
);
push("-u", "origin", "case-utils");

branch("pad-utils");
commitFile(
  repo,
  "src/pad.js",
  "export const padStart = (s, n, c = ' ') => s.padStart(n, c);\n",
  "feat(pad): add padStart"
);
push("-u", "origin", "pad-utils");

// local-experiment: a throwaway fork off pad-utils, never pushed.
branch("local-experiment");
commitFile(
  repo,
  "src/pad.js",
  "export const padStart = (s, n, c = ' ') => s.padStart(n, c);\nexport const repeat = (s, n) => s.repeat(n);\n",
  "experiment(pad): add repeat helper (local only)"
);

// trim-utils: continues the stack; pushed, then advanced by one local commit
// so it renders as "ahead 1" of origin/trim-utils.
checkout("pad-utils");
branch("trim-utils");
commitFile(
  repo,
  "src/trim.js",
  "export const collapseWhitespace = (s) => s.replace(/\\s+/g, ' ').trim();\n",
  "feat(trim): add collapseWhitespace"
);
commitFile(
  repo,
  "test/trim.test.js",
  "// covers collapseWhitespace\n",
  "test(trim): cover collapseWhitespace"
);
push("-u", "origin", "trim-utils");
commitFile(
  repo,
  "test/pad.test.js",
  "// covers padStart\n",
  "test(pad): cover padStart (local, unpushed)"
);

// Trunk advances, as other people's pull requests merge.
checkout("main");
commitFile(
  repo,
  "src/reverse.js",
  "export const reverse = (s) => [...s].reverse().join('');\n",
  "feat: add reverse",
  OTHER
);
commitFile(
  repo,
  "src/capitalize.js",
  "export const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);\n",
  "feat: add capitalize",
  OTHER
);
commitFile(
  repo,
  "src/words.js",
  "export const words = (s) => s.split(/\\s+/).filter(Boolean);\n",
  "feat: add words",
  OTHER
);
commitFile(
  repo,
  "test/reverse.test.js",
  "// covers reverse and capitalize\n",
  "test: cover reverse and capitalize",
  OTHER
);
push("origin", "main");

// escape-html: single-commit branch off the new trunk tip, never pushed.
branch("escape-html");
commitFile(
  repo,
  "src/escape.js",
  "export const escapeHtml = (s) => s.replace(/[&<>\"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\n",
  "feat: add escapeHtml"
);

// normalize-quotes: pushed, then its pull request was squash-merged and GitHub
// deleted the remote branch — so the upstream ref is configured but gone, which is
// the state `gh stack sync --prune` exists to clean up. The local commit survives
// because a squash merge lands a different commit on trunk.
checkout("main");
branch("normalize-quotes");
commitFile(
  repo,
  "src/normalize.js",
  "export const normalizeQuotes = (s) => s.replace(/[\\u2018\\u2019]/g, \"'\").replace(/[\\u201c\\u201d]/g, '\"');\n",
  "fix(normalize): fold smart quotes to ASCII"
);
push("-u", "origin", "normalize-quotes");
// Deleting the remote branch also drops the local remote-tracking ref, so the
// branch reads as "upstream gone" with no fetch --prune needed.
push("origin", "--delete", "normalize-quotes");

// More trunk work, then a fresh two-commit stack on the newest tip.
// This is the last trunk work local main follows. Everything after it is pushed
// straight to origin/main, so main stops here — see the final trunk block.
checkout("main");
commitFile(
  repo,
  "src/blank.js",
  "export const isBlank = (s) => s.trim().length === 0;\n",
  "feat: add isBlank",
  OTHER
);
commitFile(
  repo,
  "src/strip.js",
  "export const stripPrefix = (s, p) => s.startsWith(p) ? s.slice(p.length) : s;\n",
  "feat: add stripPrefix",
  OTHER
);
push("origin", "main");

// mask-utils → redact-utils: a fresh 2-commit stack, neither pushed. It forks off
// where local main comes to rest, which is what keeps both of its `gh stack` layers
// correctly based — the clean counterpart to the case-utils stack.
branch("mask-utils");
commitFile(
  repo,
  "src/mask.js",
  "export const maskEmail = (e) => e.replace(/(.).+(@.+)/, '$1***$2');\n",
  "feat(mask): add maskEmail"
);
branch("redact-utils");
commitFile(
  repo,
  "src/redact.js",
  "import { maskEmail } from './mask.js';\nexport const redactEmails = (t) => t.replace(/\\S+@\\S+/g, maskEmail);\n",
  "feat(redact): add redactEmails on top of mask"
);

// A shared branch a teammate also pushes to.
// wrap-lines is the one branch here that is not solo work, and it carries the two
// states that needs: its middle commit is authored by someone else, the fixture's
// only non-mine commit outside trunk and the one `gsm.onlyMyCommits` dims; and the
// teammate's newest commit is on origin/wrap-lines but not here, so the branch reads
// "1 behind".
checkout("main");
branch("wrap-lines");
commitFile(
  repo,
  "src/wrap.js",
  "export const wrapText = (s, width) => s.split(/\\s+/).reduce((lines, word) => {\n  const line = lines[lines.length - 1];\n  if (line && line.length + word.length + 1 <= width) {lines[lines.length - 1] = line + ' ' + word;} else {lines.push(word);}\n  return lines;\n}, []).join('\\n');\n",
  "feat(wrap): add wrapText at a column limit"
);
commitFile(
  repo,
  "test/wrap.test.js",
  "// covers wrapText at the column limit\n",
  "test(wrap): cover the column limit",
  OTHER
);
push("-u", "origin", "wrap-lines");
commitFile(
  repo,
  "src/wrap.js",
  "export const wrapText = (s, width, indent = '') => s.split(/\\s+/).reduce((lines, word) => {\n  const line = lines[lines.length - 1];\n  if (line && line.length + word.length + 1 <= width) {lines[lines.length - 1] = line + ' ' + word;} else {lines.push(indent + word);}\n  return lines;\n}, []).join('\\n');\n",
  "feat(wrap): indent continuation lines",
  OTHER
);
push("origin", "wrap-lines");
// Rewinding after the push is what leaves origin holding a commit this checkout
// does not have — the same shape as never having pulled the teammate's latest.
run(repo, "git", ["reset", "--hard", "HEAD~1"]);

// A stack that forks mid-chain.
// parse-utils branches, then splits into two tips that share its bottom commit.
// Rebasing the bottom has to move both chains, which is the path that needs a
// marker ref on the fork point.
checkout("main");
branch("parse-utils");
commitFile(
  repo,
  "src/parse.js",
  "export const parseList = (s) => s.split(',').map((p) => p.trim());\n",
  "feat(parse): add parseList"
);
const parseForkPoint = run(repo, "git", ["rev-parse", "HEAD"]);
branch("parse-numbers");
commitFile(
  repo,
  "src/parseNumbers.js",
  "import { parseList } from './parse.js';\nexport const parseNumbers = (s) => parseList(s).map(Number);\n",
  "feat(parse): add parseNumbers"
);
detach(parseForkPoint);
branch("parse-dates");
commitFile(
  repo,
  "src/parseDates.js",
  "import { parseList } from './parse.js';\nexport const parseDates = (s) => parseList(s).map((d) => new Date(d));\n",
  "feat(parse): add parseDates"
);

// A branch that conflicts with trunk on purpose.
// Both this branch and a later trunk commit rewrite the same line of
// src/truncate.js, so rebasing it onto trunk stops for manual resolution.
detach(trunkBaseline);
branch("truncate-words");
commitFile(
  repo,
  "src/truncate.js",
  "export const truncate = (s, n) => s.length > n ? s.slice(0, s.lastIndexOf(' ', n)) + '…' : s;\n",
  "feat(truncate): break at word boundaries"
);

// The final trunk commits, which reach origin/main only.
// Committed on a detached HEAD and pushed straight to origin/main, so local main
// stays where the stacks above forked from. That is the ordinary state of a
// repository someone fetches but has not pulled, and it is also what makes the two
// `gh stack` badge states differ: the case-utils stack forked before these commits
// and reads as needing a rebase, while the mask-utils stack forked at local main and
// stays clean.
detach("main");
commitFile(
  repo,
  "src/truncate.js",
  "export const truncate = (s, n, suffix = '…') => s.length > n ? s.slice(0, n) + suffix : s;\n",
  "feat(truncate): make the ellipsis configurable",
  OTHER
);
commitFile(
  repo,
  "src/repeat.js",
  "export const repeat = (s, n) => s.repeat(Math.max(0, n));\n",
  "feat: add repeat",
  OTHER
);
commitFile(
  repo,
  "src/count.js",
  "export const countOccurrences = (s, sub) => s.split(sub).length - 1;\n",
  "feat: add countOccurrences",
  OTHER
);
commitFile(
  repo,
  "test/repeat.test.js",
  "// covers repeat and countOccurrences\n",
  "test: cover repeat and countOccurrences",
  OTHER
);
push("origin", "HEAD:main");
checkout("main");

// gh stack membership.
// Two stacks, reusing the chains already here rather than adding branches: one stack
// cannot show both badge states at once, and "Layer 2 of 3" only reads unambiguously
// with a second stack on screen to compare it against.
//
// case-utils → pad-utils → trim-utils forked back at the slugify commit and trunk
// has moved repeatedly since, so its bottom layer's recorded base no longer matches
// main — layer 1 draws "needs rebase" while 2 and 3 stay clean. mask-utils →
// redact-utils forked at where local main sits, so all of it is clean.
writeGhStackState(repo, [
  { trunk: "main", branches: ["case-utils", "pad-utils", "trim-utils"] },
  { trunk: "main", branches: ["mask-utils", "redact-utils"] },
]);
verifyStackBadges(repo, {
  "case-utils": "1/3 needs rebase",
  "pad-utils": "2/3",
  "trim-utils": "3/3",
  "mask-utils": "1/2",
  "redact-utils": "2/2",
});

console.log(
  [
    `Demo repo ready: ${repo}`,
    `  bare origin:  ${join(destination, "origin.git")}`,
    "  gh stacks:    case-utils → pad-utils → trim-utils (layer 1 needs rebase)",
    "                mask-utils → redact-utils (every layer correctly based)",
    "  sync badges:  case-utils, pad-utils (submitted), trim-utils (1 unsubmitted)",
    "                fix-slugify-unicode (diverged 1↑1↓), wrap-lines (1 behind)",
    "                normalize-quotes (upstream gone), and several never pushed",
    "  branches:     escape-html, mask-utils, redact-utils, wip-titlecase, local-experiment",
    "                parse-utils → parse-numbers / parse-dates (a stack that forks mid-chain)",
    "                wrap-lines (carries a teammate's commit — try gsm.onlyMyCommits)",
    "                truncate-words (conflicts with trunk on purpose — try rebasing it onto trunk)",
    "",
    `Serve it:  just web ${repo}`,
  ].join("\n")
);
