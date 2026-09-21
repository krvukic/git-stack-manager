/**
 * Vite build for the webview bundle.
 *
 * The webview is the one part of this repository that runs in a browser rather than in
 * Node, so it gets its own build: `tsc -p .` still compiles `src/` to CommonJS for the
 * extension host and the web server, and this compiles `src/webview/` to a single
 * browser bundle. The two never share output.
 */
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  /**
   * No alias for the `#git/*` specifiers, deliberately.
   *
   * Every one of the webview's imports from the Node side is `import type`, so TypeScript erases
   * them and the bundler never sees one — an alias here resolves nothing. Vite would not need it
   * even if one survived: it reads `package.json`'s `imports` field itself. What the alias *did*
   * do was silently redirect an accidental value import from `out/*.js` to the TypeScript source,
   * which is the opposite of useful — it made dropping the `type` keyword quieter, and 11kB of
   * `child_process` reaching a browser bundle should be loud.
   *
   * Type resolution is `tsconfig.webview.json`'s `paths` block, which is the one copy of this
   * mapping that earns its place.
   */
  build: {
    outDir: "media/dist",
    emptyOutDir: true,
    // The webview is Chromium, and its version tracks the host Electron rather than
    // whatever browsers a `browserslist` default would cover.
    target: "chrome120",
    // Off because this ships inside a locally-built extension where bundle size buys nothing,
    // and a readable bundle is what makes the webview debuggable through
    // *Developer: Open Webview Developer Tools*.
    minify: false,
    /**
     * Emit the stylesheet as a file instead of injecting it at runtime.
     *
     * Not a preference — the page ships `default-src 'none'` with no `unsafe-inline`,
     * and for an IIFE build Vite otherwise appends the CSS to the bundle as a
     * `<style>` element it creates on load. The browser refuses that element and the
     * smartlog renders completely unstyled. Turning code splitting off is what routes
     * the CSS back through `assetFileNames` to `media/dist/app.css`, which the HTML
     * links and the CSP allows.
     */
    cssCodeSplit: false,
    sourcemap: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/webview/main.tsx"),
      output: {
        /**
         * IIFE rather than ES modules. A webview loads over the opaque `vscode-webview://`
         * origin, where module resolution and CORS behave differently enough from `http://` to
         * be worth avoiding; one self-contained script loads identically in both hosts.
         */
        format: "iife",
        /**
         * Fixed names rather than content hashes. Both hosts reference the bundle by name — the
         * extension through `asWebviewUri`, the server through a static route — so a hash would
         * mean reading a manifest at runtime to find it. Nothing needs cache busting either: the
         * extension mints a fresh webview URI on every open, and the server sends `no-store`.
         */
        entryFileNames: "app.js",
        assetFileNames: "app.[ext]",
      },
    },
  },
});
