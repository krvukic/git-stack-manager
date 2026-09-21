/**
 * Report Tailwind classes that have a shorter spelling.
 *
 * This exists because the diagnostic has no other command-line home. VS Code's Tailwind
 * extension reports `min-h-[110px] can be written as min-h-27.5` through
 * `tailwindCSS.lint.suggestCanonicalClasses`, and the ESLint plugin's equivalent rule
 * calls the same API without the `rem` argument that converts a pixel value to a spacing
 * step — so it finds the two `text-(length:…)` sites and misses two dozen pixel ones. The
 * gap showed up as a repository where every check passed and the editor was full of
 * squiggles.
 *
 * Run through `just canonical-classes`, or `--fix` to rewrite in place.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { __unstable__loadDesignSystem } from "tailwindcss";

/**
 * The root font size the suggestions are computed against.
 *
 * 16px because nothing sets `font-size` on `html` — `theme.css` sets it on `body`, which is
 * an inherited text size and never a `rem` basis. So `--spacing: 0.25rem` is exactly 4px
 * and `min-h-27.5` is exactly 110px. An `html { font-size }` rule would silently make every
 * suggestion below wrong, which is the one change that has to be made together with this
 * constant.
 */
const ROOT_FONT_SIZE = 16;

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const STYLESHEET = path.join(REPOSITORY_ROOT, "src/webview/styles.css");
const SOURCE_ROOT = path.join(REPOSITORY_ROOT, "src/webview");

/** @param {string} directory @returns {string[]} */
function filesUnder(directory) {
  return readdirSync(directory).flatMap(entry => {
    const full = path.join(directory, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

const designSystem = await __unstable__loadDesignSystem(
  readFileSync(STYLESHEET, "utf8"),
  {
    base: path.dirname(STYLESHEET),
    loadStylesheet: async (id, base) => {
      const resolved =
        id === "tailwindcss"
          ? path.join(REPOSITORY_ROOT, "node_modules/tailwindcss/index.css")
          : path.resolve(base, id);
      return {
        path: resolved,
        base: path.dirname(resolved),
        content: readFileSync(resolved, "utf8"),
      };
    },
  }
);

/**
 * One candidate per call, deliberately.
 *
 * `canonicalizeCandidates` drops what it does not recognise instead of echoing it, so a
 * batch comes back shorter than it went in and every index after the first unknown token
 * lines up with the wrong input. Batching a whole class list reported prose from
 * neighbouring string literals as class suggestions.
 *
 * The answer is cached because a token is a class name: `text-meta` and `flex-none` reach
 * the design system once each rather than once per element that carries them, and every
 * English word in a title attribute is asked about once for the whole run.
 *
 * @type {Map<string, string | null>}
 */
const canonicalByToken = new Map();

/**
 * @param {string} candidate
 * @returns {string | null} The shorter spelling, or null if this one is already canonical.
 */
function canonicalize(candidate) {
  const cached = canonicalByToken.get(candidate);
  if (cached !== undefined) {
    return cached;
  }
  const result = designSystem.canonicalizeCandidates([candidate], {
    rem: ROOT_FONT_SIZE,
  });
  const canonical =
    result.length === 1 && result[0] !== candidate ? result[0] : null;
  canonicalByToken.set(candidate, canonical);
  return canonical;
}

const fix = process.argv.includes("--fix");
/** @type {{ file: string; line: number; from: string; to: string }[]} */
const findings = [];

for (const file of filesUnder(SOURCE_ROOT).filter(f => /\.tsx?$/.test(f))) {
  const original = readFileSync(file, "utf8");
  const lines = original.split("\n");
  let changed = false;
  lines.forEach((line, index) => {
    // Every quoted run, not just `className`. A class list reaches an element through
    // `classes()` arguments and through variant records too, and all of them are strings.
    for (const literal of line.matchAll(/["'`]([^"'`\n]*)["'`]/g)) {
      for (const token of literal[1].trim().split(/\s+/).filter(Boolean)) {
        const canonical = canonicalize(token);
        if (!canonical) {
          continue;
        }
        findings.push({
          file: path.relative(REPOSITORY_ROOT, file),
          line: index + 1,
          from: token,
          to: canonical,
        });
        if (fix) {
          // Word-bounded on both sides, so `py-1` never matches inside `py-1.25`.
          lines[index] = lines[index].replaceAll(
            new RegExp(`(?<![\\w./[-])${escape(token)}(?![\\w./\\]-])`, "g"),
            canonical
          );
          changed = true;
        }
      }
    }
  });
  if (changed) {
    writeFileSync(file, lines.join("\n"));
  }
}

/** @param {string} text */
function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (!findings.length) {
  console.log("Every Tailwind class is already in its shortest form.");
  process.exit(0);
}

for (const { file, line, from, to } of findings) {
  console.log(`${file}:${line}  ${from}  ->  ${to}`);
}
console.log(
  `\n${findings.length} class${findings.length === 1 ? "" : "es"} with a shorter spelling.` +
    (fix ? " Rewritten." : " Run with --fix to rewrite.")
);
process.exit(fix ? 0 : 1);
