/**
 * Prettier configuration. Prettier owns layout and import order, so neither is a review
 * topic; `STYLE_GUIDE.md` covers what formatting cannot decide.
 *
 * The Tailwind class sorter runs on the webview, which is where the Tailwind is. It must
 * stay last in `plugins` — it rewrites the class strings the other plugins have already
 * formatted, and ordering it earlier makes its output depend on which plugin ran when.
 *
 * @type {import("prettier").Config}
 */
module.exports = {
  arrowParens: "avoid",
  trailingComma: "es5",
  plugins: [
    require.resolve("@ianvs/prettier-plugin-sort-imports"),
    require.resolve("prettier-plugin-tailwindcss"),
  ],
  /**
   * Where the sorter learns this project's classes.
   *
   * Without it the plugin sorts against stock Tailwind, so every token `theme.css` defines
   * (`bg-card`, `text-muted`, the `@custom-variant`s) is a name it does not recognise and
   * leaves untouched. `format:check` passed because the sorter was a silent no-op on exactly
   * the classes worth sorting.
   */
  tailwindStylesheet: "./src/webview/styles.css",
  importOrder: ["<THIRD_PARTY_MODULES>", "^[./]"],
  importOrderTypeScriptVersion: "5.0.2",
  importOrderParserPlugins: ["typescript", "jsx", "decorators-legacy"],
};
