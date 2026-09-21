/**
 * The graph as first drawn: lanes, rails, dots, and the trunk row.
 *
 * The demo repository was built to produce the states these cover — a stack in sync with
 * origin, one ahead of it, never-pushed branches, a fork mid-chain — so a change to lane
 * assignment shows up in a picture rather than as a bug someone notices later. What a
 * picture cannot judge is colour against colour and rail against text, which is why the
 * legibility tests measure instead.
 */
import { expect, test } from "./fixtures/demoRepo.mjs";

test("the tree draws the demo repository's stacks, bases, and branch badges", async ({
  snapshot,
}) => {
  await snapshot("initial-tree");
});

/**
 * The one badge that belongs to a row rather than to a branch pill.
 *
 * The demo repository's local `main` trails `origin/main`, the ordinary state of a
 * repository someone fetches but has not pulled. That branch has no commits of its own, so
 * it gets no row and no pill, and nothing else on the graph can carry the count: a trunk
 * several commits stale looked current, while the editor's own status bar carried the
 * number all along.
 */
test("the trunk row reports how far the local trunk branch trails it", async ({
  demoRepository,
  smartlog,
}) => {
  const behind = Number(
    await demoRepository.git(["rev-list", "--count", "main..origin/main"])
  );
  expect(behind).toBeGreaterThan(0);

  const trunkRow = smartlog.locator(".row", {
    has: smartlog.locator(".trunkpill"),
  });
  await expect(trunkRow).toContainText(`main is ${behind} behind`);
  // main is checked out here, so its Goto would run a checkout that changes nothing. The
  // badge's own wording points at Pull instead.
  await expect(trunkRow.locator(".goto-btn")).toHaveCount(0);
});

/**
 * The rail colour, and the one thing that moves it.
 *
 * White on the dark palette both hosts fall back to, black under a light editor theme —
 * which VS Code announces with a class on the webview's body, so nothing detects it. The
 * light half is unphotographable here: the web host has no light palette to switch to, and
 * a stroke would be a handful of pixels of a picture either way. Reading the computed
 * colour also proves the token resolves at all — the rails used to name a fallback, and
 * dropping it means an unset `--color-rail` would paint them black on black.
 */
test("the rails follow the editor's light or dark theme", async ({
  smartlog,
}) => {
  const railStroke = () =>
    smartlog.evaluate(() => {
      const rail = document.querySelector(".rail line, .rail path");
      return rail ? getComputedStyle(rail).stroke : null;
    });
  expect(await railStroke()).toBe("rgb(255, 255, 255)");

  await smartlog.evaluate(() => document.body.classList.add("vscode-light"));
  expect(await railStroke()).toBe("rgb(0, 0, 0)");
});

/**
 * VS Code's two default themes, in the tokens the gutter's dots reach for.
 *
 * Dark Modern and Light Modern, which is what nearly every user is looking at. Badge
 * foreground earns its place by being the one that broke: both themes set it to white, so a
 * dot painted in it scored 1:1 against Light Modern's editor and could not be seen at all.
 * A theme picks that colour to contrast with its badge, and with nothing else.
 */
const VSCODE_THEMES = [
  {
    kind: "vscode-dark",
    tokens: {
      "--vscode-editor-background": "#1f1f1f",
      "--vscode-focusBorder": "#0078d4",
      "--vscode-badge-foreground": "#ffffff",
      "--vscode-descriptionForeground": "#9d9d9d",
      "--vscode-gitDecoration-addedResourceForeground": "#81b88b",
    },
  },
  {
    kind: "vscode-light",
    tokens: {
      "--vscode-editor-background": "#ffffff",
      "--vscode-focusBorder": "#005fb8",
      "--vscode-badge-foreground": "#ffffff",
      "--vscode-descriptionForeground": "#3b3b3b",
      "--vscode-gitDecoration-addedResourceForeground": "#587c0c",
    },
  },
];

/** WCAG's floor for a graphical object rather than for text, which a dot is. */
const MINIMUM_CONTRAST = 3;

/** Every dot the gutter can draw, as `rails.mts` spells the classes. */
const NODE_VARIANTS = ["node", "node head", "node hollow", "node trunkdot"];

/**
 * WCAG relative luminance of a computed `rgb(r, g, b)`.
 *
 * @param {string} colour
 */
function relativeLuminance(colour) {
  const [red, green, blue] = [...colour.matchAll(/[\d.]+/g)]
    .slice(0, 3)
    .map(([channel]) => {
      const ratio = Number(channel) / 255;
      return ratio <= 0.04045
        ? ratio / 12.92
        : ((ratio + 0.055) / 1.055) ** 2.4;
    });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * 1 for two identical colours, 21 for black against white.
 *
 * @param {string} foreground
 * @param {string} background
 */
function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/**
 * Every dot the gutter can draw, against the editor background, on both themes.
 *
 * The test above proves the rail's colour follows the theme; this one proves the result can
 * be seen, which is the half that kept breaking. Trunk's dot was painted in
 * `--vscode-badge-foreground` and vanished on a light theme, and the base dot's ring was a
 * description colour dimmer than the lane running behind it. Both are one mistake — taking a
 * colour a theme guarantees against some *other* surface — so what is asserted is the
 * contrast rather than the colour, and the failure message names which dot went dim.
 *
 * The rail's own lines stay with the test above: black on white or white on black is 21:1 by
 * construction, so there is nothing to measure.
 */
test("every dot stays legible on both of VS Code's default themes", async ({
  smartlog,
}) => {
  for (const theme of VSCODE_THEMES) {
    const { background, drawn, inks } = await smartlog.evaluate(
      ({ applied, variants }) => {
        // VS Code declares its tokens on the root and stamps the theme kind on the body,
        // and the split matters here: `--color-bg` and the rest are declared on the root
        // too, so a token set on the body would arrive too late to substitute into them.
        document.body.classList.remove("vscode-dark", "vscode-light");
        document.body.classList.add(applied.kind);
        for (const [token, value] of Object.entries(applied.tokens)) {
          document.documentElement.style.setProperty(token, value);
        }
        // A base dot is filled with the background it sits on, so its ring is the only
        // part of it there is to see.
        const inkOf = (/** @type {Element} */ dot) => {
          const style = getComputedStyle(dot);
          return style.stroke === "none" ? style.fill : style.stroke;
        };
        const rail = document.querySelector(".rail");
        if (!rail) {
          throw new Error("no rail gutter to probe");
        }
        /*
         * Each rule is measured on a probe rather than on whichever dots this tree happens
         * to draw, because the demo draws no head dot at all: it ends on a base commit, and
         * base wins the variant. The probe sits inside a real `.rail`, so it resolves
         * through the same cascade the drawn dots do — the stylesheet is the thing under
         * test. What the tree draws is checked separately, below.
         */
        const probe = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "circle"
        );
        rail.append(probe);
        const inks = variants.map(variant => {
          probe.setAttribute("class", variant);
          return { variant, ink: inkOf(probe) };
        });
        probe.remove();
        return {
          background: getComputedStyle(document.body).backgroundColor,
          drawn: Array.from(document.querySelectorAll(".rail .node"), dot =>
            dot.getAttribute("class")
          ),
          inks,
        };
      },
      { applied: theme, variants: NODE_VARIANTS }
    );

    // Nothing on screen may escape the measurement above, and an empty gutter is not a
    // pass: a lane assignment that stopped drawing dots would otherwise satisfy this test.
    expect(drawn.length).toBeGreaterThan(0);
    for (const variant of new Set(drawn)) {
      expect(NODE_VARIANTS).toContain(variant);
    }
    for (const { variant, ink } of inks) {
      expect(
        contrastRatio(ink, background),
        `${variant} on ${theme.kind}: ${ink} against ${background}`
      ).toBeGreaterThanOrEqual(MINIMUM_CONTRAST);
    }
  }
});

test("no rail crosses the text of the row it belongs to", async ({
  smartlog,
}) => {
  // A base collecting several stacks draws one fork curve per stack, each running
  // horizontally along the row's top edge from its own lane back to the trunk. Those runs
  // start right of where the text began, so all three cut straight through "feat: add
  // stripPrefix" — the indent was computed from the lane at mid-row only, which is where
  // the text sits but not where the curves are.
  const crossings = await smartlog.evaluate(() => {
    const offenders = [];
    for (const row of Array.from(document.querySelectorAll("#tree .row"))) {
      const content = row.querySelector(".content");
      const rail = row.querySelector("svg.rail");
      if (!content || !rail) {
        continue;
      }
      // The rightmost point any rail reaches in this row, in the row's own coordinates.
      let railRight = 0;
      for (const line of Array.from(rail.querySelectorAll("line"))) {
        railRight = Math.max(railRight, Number(line.getAttribute("x1")));
      }
      for (const path of Array.from(rail.querySelectorAll("path"))) {
        for (const match of (path.getAttribute("d") ?? "").matchAll(
          /(\d+(?:\.\d+)?) \d/g
        )) {
          railRight = Math.max(railRight, Number(match[1]));
        }
      }
      const textLeft = Math.round(
        content.getBoundingClientRect().left - row.getBoundingClientRect().left
      );
      if (textLeft < railRight) {
        offenders.push({
          text: (content.textContent || "").trim().slice(0, 40),
          textLeft,
          railRight,
        });
      }
    }
    return offenders;
  });
  expect(crossings).toEqual([]);
});
