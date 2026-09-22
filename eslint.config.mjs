/**
 * ESLint configuration.
 *
 * The rules here are the machine-checkable subset of `STYLE_GUIDE.md`. Anything that
 * guide states and a linter can verify belongs in this file rather than in a reviewer's
 * head. The rest stays a review concern: naming that carries domain meaning, and comments
 * that explain why.
 */
import js from "@eslint/js";
import betterTailwind from "eslint-plugin-better-tailwindcss";
import reactHooks from "eslint-plugin-react-hooks";
import typescriptEslint from "typescript-eslint";

/**
 * Style-guide rules that apply to every file, TypeScript or not.
 *
 * `as const` so each entry keeps its tuple shape. Without it `["error", "all"]` widens to
 * `string[]`, which no longer satisfies ESLint's own `RuleEntry`, and the working config
 * type-checks as one error.
 *
 * @satisfies {import("eslint").Linter.RulesRecord}
 */
const sharedRules = /** @type {const} */ ({
  // "Always use braces": a brace-less body silently excludes a second statement
  // added later.
  curly: ["error", "all"],
  eqeqeq: ["error", "always", { null: "ignore" }],
  "no-console": "error",
  "no-var": "error",
  "prefer-const": "error",
  // "Use Number.isFinite()/Number.isNaN(), not the global versions": the globals
  // coerce their argument, so isNaN("") is false.
  "no-restricted-globals": [
    "error",
    {
      name: "isNaN",
      message: "Use Number.isNaN() — the global coerces its argument.",
    },
    {
      name: "isFinite",
      message: "Use Number.isFinite() — the global coerces its argument.",
    },
  ],
});

/**
 * The type-aware rules worth having, picked rather than taken as a preset.
 *
 * `recommendedTypeChecked` reports 67 findings here and `strictTypeChecked` 268, but 150 of
 * the latter are two stylistic rules that would be switched straight back off. These are the
 * ones that find something a reviewer would want to know about:
 *
 * - `no-misused-promises` catches an async function handed to a slot typed `void`, which is
 *   13 of the webview's event handlers. `no-floating-promises` is already on and cannot see
 *   them: the promise is not dropped, it is passed somewhere that ignores it.
 * - `no-base-to-string` caught a real one — `String()` on an `unknown` from parsed JSON in
 *   `pullRequests.ts`, which would yield `"[object Object]"` and silently fail every status
 *   comparison below it if GitHub ever returned an object there.
 * - The four `no-unsafe-*` rules cover the two places untyped data enters: the VS Code API
 *   and the RPC bridge. They report values that became `any` by inference rather than by
 *   annotation, which is exactly what `no-explicit-any` cannot see.
 */
const typedRules = /** @type {const} */ ({
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/no-base-to-string": "error",
  "@typescript-eslint/no-unnecessary-type-assertion": "error",
  "@typescript-eslint/prefer-promise-reject-errors": "error",
  "@typescript-eslint/no-unsafe-argument": "error",
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-return": "error",
  "@typescript-eslint/no-unsafe-call": "error",
});

/**
 * DOM globals for the Node files that stringify a reader and evaluate it in the page.
 *
 * `page.evaluate` takes a function whose body runs in the browser, so `document` is in
 * scope there and nowhere else in the same file. Without these, `no-undef` reports every
 * such reader.
 *
 * `as const` for the same reason `sharedRules` needs it: each value widens to `string`
 * otherwise, which no longer satisfies ESLint's `GlobalsConfig`.
 *
 * @satisfies {import("eslint").Linter.Globals}
 */
const pageEvaluationGlobals = /** @type {const} */ ({
  document: "readonly",
  window: "readonly",
  getComputedStyle: "readonly",
  HTMLElement: "readonly",
});

export default typescriptEslint.config(
  {
    ignores: [
      "out/**",
      "node_modules/**",
      ".demo-repo/**",
      "*.vsix",
      "media/dist/**",
    ],
  },

  js.configs.recommended,
  ...typescriptEslint.configs.recommended,

  {
    // `.mts` as well as `.ts`. The webview's model and graph modules use that extension
    // so Node can run them directly in the tests, and a glob of `*.ts` matched none of
    // them — nine files were linted by the recommended presets alone, with no `no-console`,
    // no `curly`, and none of the react-hooks rules.
    files: ["src/**/*.{ts,mts}"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...sharedRules,

      // "Never use interface": interface declarations merge across files, which
      // lets distant code silently alter a shape.
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],

      // "Never use any": it disables checking for the value and propagates.
      "@typescript-eslint/no-explicit-any": "error",

      // "No top-level arrow functions": declarations hoist, carry their name in
      // stack traces, and read as code rather than data. The guide scopes this to
      // module level — a closure that captures local state has no declaration
      // equivalent — so this targets only `const f = () => …` at the top level.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Program > VariableDeclaration > VariableDeclarator > :matches(ArrowFunctionExpression, FunctionExpression)",
          message:
            "Top-level functions must use the `function` keyword, not an arrow.",
        },
        {
          selector: "TSEnumDeclaration",
          message: "Use a string union type instead of an enum.",
        },
      ],

      // Unused code is either a leftover or a mistake. Leading underscore opts out,
      // for the deliberately-ignored parameter.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // A promise dropped on the floor loses its rejection; every call here either
      // awaits or explicitly discards.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      ...typedRules,
    },
  },

  {
    /**
     * The webview runs in a browser, so it gets the DOM globals the Node side has no
     * business touching, and its own tsconfig — `src/tsconfig.json` covers Node code
     * and excludes this directory.
     *
     * `no-console` stays on, as everywhere else: the browser console is for debugging,
     * and the command log panel is where this UI reports what it did.
     */
    files: ["src/webview/**/*.{ts,mts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.webview.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...sharedRules,
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      ...typedRules,
      /**
       * The Node side bans top-level arrow functions, and a component is exactly that
       * shape — but React components are conventionally `function` declarations anyway,
       * so the rule carries over unchanged. Only the enum clause is dropped: it lives
       * in the same rule and there is nothing here to exempt it for.
       */
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Program > VariableDeclaration > VariableDeclarator > :matches(ArrowFunctionExpression, FunctionExpression)",
          message:
            "Top-level functions must use the `function` keyword, not an arrow.",
        },
        {
          selector: "TSEnumDeclaration",
          message: "Use a string union type instead of an enum.",
        },
      ],
    },
  },

  {
    /**
     * Tailwind class checks, resolved against this project's own theme.
     *
     * Six rules of the plugin's fifteen. The rest are either noise here or belong to
     * `scripts/canonical-classes.mjs`, which catches what this cannot:
     *
     * - `enforce-logical-properties` suggests `ms-`/`me-` over `ml-`/`mr-`, which is 112
     *   findings for a UI that never flips direction.
     * - `enforce-canonical-classes` stays on for the two `text-(length:…)` forms it does
     *   find, but it calls Tailwind without a root font size, so every pixel-to-spacing
     *   suggestion is invisible to it. That is what the script covers.
     */
    files: ["src/webview/**/*.tsx"],
    plugins: { "better-tailwindcss": betterTailwind },
    settings: {
      "better-tailwindcss": { entryPoint: "src/webview/styles.css" },
    },
    rules: {
      /**
       * The typo net: it is the rule that would have caught the `class="rowhead"` fusion
       * `classes.ts` exists to prevent.
       *
       * Every name below is a deliberate hook rather than a style, which is why an
       * allowlist had to come first. Three kinds, and the kind decides whether removing
       * one is safe:
       *
       * - Selected by the end-to-end suite (`chip`, `chooselines`, `dffile`, `dfimage`,
       *   `excluded`, `linecount`, `ln`, `log-cmd`, `log-entry`, `log-title`, `open`, `pick`,
       *   `pickfile`, `pickhunk`, `pickline`, `review`, `seg`, `whole`). Deleting one breaks a
       *   test rather than the appearance.
       * - Targeted by a descendant selector from a parent's class string (`code`, `mark`,
       *   `st`, and the `graph.css` set). `[&>.mark]:text-add` in `ChangesOverlay` is the
       *   shape — the child is named by the parent, so nothing here is dead.
       * - Styled by `graph.css`, which is hand-written CSS Tailwind never emitted
       *   (`basehint`, `content`, `ellipsis-label`, `ellipsis-row`, `foreign`, `goto-btn`,
       *   `halo`, `node`, `pillgroup`, `rail`, `railfill`, `row`, `sha`, `subject`).
       *
       * Anchored patterns, not bare names: the option takes regular expressions, so
       * `row` unanchored would also excuse a misspelled `rowhead`.
       */
      "better-tailwindcss/no-unknown-classes": [
        "error",
        {
          ignore: [
            "^basehint$",
            "^branchrow$",
            "^chip$",
            "^chooselines$",
            "^code$",
            "^content$",
            "^dffile$",
            "^dfhunk$",
            "^dfimage$",
            "^discard$",
            "^ellipsis-label$",
            "^ellipsis-row$",
            "^excluded$",
            "^files$",
            "^foreign$",
            "^goto-btn$",
            "^halo$",
            "^linecount$",
            "^ln$",
            "^log-cmd$",
            "^log-entry$",
            "^log-title$",
            "^mark$",
            "^node$",
            "^open$",
            "^pick$",
            "^pickfile$",
            "^pickhunk$",
            "^pickline$",
            "^pillgroup$",
            "^rail$",
            "^railfill$",
            "^review$",
            "^row$",
            "^seg$",
            "^sha$",
            "^st$",
            "^subject$",
            "^whole$",
          ],
        },
      ],
      "better-tailwindcss/no-conflicting-classes": "error",
      "better-tailwindcss/no-duplicate-classes": "error",
      "better-tailwindcss/no-deprecated-classes": "error",
      "better-tailwindcss/enforce-consistent-important-position": "error",
      "better-tailwindcss/enforce-canonical-classes": "error",
      /**
       * `il0`–`il8` are hand-written in `graph.css`, not generated, so building the name
       * by interpolation cannot purge a class Tailwind never emitted. The rule is right
       * in general and wrong for this one line.
       */
      "better-tailwindcss/no-concatenated-classes": "off",
    },
  },

  {
    // Tests drive the compiled output through `require`, so they are plain ESM
    // JavaScript rather than TypeScript.
    files: ["test/**/*.mjs", "scripts/**/*.mjs", "*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        setImmediate: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
    rules: {
      ...sharedRules,
      // These are command-line programs: printing to the terminal is their output,
      // not stray debugging.
      "no-console": "off",
    },
  },

  {
    // Prettier resolves its config through `require`, so this one file is CommonJS
    // while everything else here is ESM. `module` and `require` are genuinely in
    // scope there; without declaring them, `no-undef` reports the working config as
    // two errors.
    files: ["prettier.config.js"],
    languageOptions: {
      globals: { module: "writable", require: "readonly" },
    },
  },

  {
    // The screenshot script drives a page the same way the suite does, so it needs the
    // page globals without the two Playwright-fixture exemptions below it.
    files: ["scripts/screenshot.mjs"],
    languageOptions: { globals: pageEvaluationGlobals },
  },

  {
    // The end-to-end suite spans two runtimes: most of it is Node, but the
    // serializer's page reader is stringified and evaluated in the browser, so
    // `document` is legitimately in scope there.
    files: ["test/e2e/**/*.mjs"],
    languageOptions: { globals: pageEvaluationGlobals },
    rules: {
      // Playwright's fixture signature is `async ({}, use)` for a fixture that
      // depends on nothing — the empty pattern is the API, not an oversight.
      "no-empty-pattern": "off",
      // Git's own field and record separators are control characters; matching
      // them to render a readable snapshot is the point.
      "no-control-regex": "off",
    },
  }
);
