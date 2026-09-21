# Learnings

Things that cost real time to find while porting the webview to React, Vite, and Tailwind, and that
would cost it again. Each is a trap where **nothing throws**: the markup stays valid, the build
succeeds, and the only symptom is that the screen is subtly wrong.

The versions these were found against are Tailwind 4.3.3 and `prettier-plugin-tailwindcss` 0.8.1.
Each section ends with the command that re-checks the claim, so a future upgrade can be tested
rather than assumed. Run them from the repository root, and after `just build`, since two of them
read the compiled bundle.

**This file owns the cross-cutting traps; a code comment owns the local why.** When both apply, the
comment names the constraint in one line and points here rather than restating the investigation.
`src/webview/classes.ts` is the model. The reason to keep them apart is in the hover section below.
That workaround was justified partly by a claim about headless Chromium that turned out to be false,
and the claim had been restated in two places, so both copies had to be wrong before anyone noticed
either. One copy is easier to re-check than two.

## `height: auto` does not grow a `nowrap` flex container, however tall its items get

A flex container's cross size comes from its flex *lines*. With `flex-wrap: nowrap` there is exactly
one line no matter what happens inside the items, so a text child that breaks onto a second line is
laid out at the container's original height and the overflow is painted outside it, or clipped under
`overflow: hidden`.

This is what the row-wrapping mode was doing. `body.wrap-rows` lifted `height` to `auto` and raised
`white-space: normal` on the subject, but left the base rule's `flex-wrap: nowrap` and
`overflow: hidden` in place, so 25 of 28 rows silently truncated their second line.

It survived review for a reason worth remembering: **the bug's visibility depended on
`align-items`.** Under `baseline`, `auto` resolved about 3px taller than under `center`, which was
enough for three of the 28 rows to fit. The end-to-end test asserted only that *some* row grew
taller than the others, and three passing rows satisfied that. Switching the row to `center` took
those 3px away, the count went to zero, and the assertion finally failed on a bug that had always
been there.

**What follows from it.** A mode that turns wrapping on has to lift every part of the rule that
turned it off: `flex-wrap` and `overflow`, not just `height`. And an assertion of the form "at least
one element differs" is satisfied by an accident. Prefer one that names the count, or that measures
the thing directly (here: whether any subject's rendered text exceeds its box).

Re-check it:

```bash
grep -A6 'wrap-rows .row .content' src/webview/graph.css   # flex-wrap, height, and overflow
```

## A shorter class name can lose to the arbitrary value it replaced

Two utilities that set the same property are decided by source order, and Tailwind emits the numeric
scale in ascending order with arbitrary values _after_ all of it. So replacing an arbitrary value
with its scale equivalent can move it from the winning side to the losing side:

```
before:  .px-1\.5   .px-2   .px-2\.5   .px-3   .px-\[7px\]     <- px-[7px] beats px-2
after:   .px-1\.5   .px-1\.75   .px-2   .px-2\.5   .px-3       <- px-2 now beats px-1.75
```

`px-[7px]` and `px-1.75` compute to the same 7px, so a computed-style check on either class _alone_
says the swap is free. It is not free on an element that also carries `px-2` from a base component,
which is exactly what `TextInput` does. The commit form's two inputs went from 7px to 8px of
horizontal padding, and nothing else on the page moved.

**What follows from it.** A canonical-class rewrite is only pixel-identical for an element whose
class list has one utility per property. Where a component bakes in a value a caller overrides, fix
the component instead of restoring the arbitrary value: the override was already relying on emission
order, which is not something a reader can see. `ButtonRow`'s `mt-2.5` was the same pattern one
property over. Four callers cancelled it with `!important`, and the margin now lives on the callers
that set it.

Re-check it, since the emitted order is the whole claim:

```bash
grep -oE '^  \.px-[^ ]*' media/dist/app.css   # ascending scale, arbitrary values last
```

## An unlayered CSS rule beats a layered utility, whichever comes first

Tailwind emits its utilities inside `@layer utilities`. Any rule _outside_ a layer, such as a plain
`button { … }` or a `.iconbtn { … }`, outranks every layered rule regardless of source order,
because the cascade sorts unlayered declarations above layered ones before it ever considers order
or specificity.

This bit three times during the conversion, and each time the symptom was the same and deeply
misleading: the element's `class` attribute read exactly right, and its computed style disagreed.

| Leftover rule                       | What it suppressed                                    |
| ----------------------------------- | ----------------------------------------------------- |
| `button { font-size: 12px }`        | `text-meta/auto` on the log's Clear button            |
| `.iconbtn { visibility: hidden }`   | `group-hover/file:visible` on the file-row actions    |
| `#absorb-preview { display: none }` | the preview panel's own `block`, so it never appeared |

**What follows from it.** While a hand-written rule survives on an element, utilities on that
element are advisory. So a region has to be converted _and_ its old rules deleted in the same step.
A half-converted element is worse than an unconverted one, because it looks converted. When a class
list plainly says one thing and the computed style says another, look for an unlayered rule before
doubting the utility.

Re-check it:

```bash
node -e 'const{chromium}=require("playwright");(async()=>{const b=await chromium.launch();
const p=await b.newPage();await p.setContent(`<style>@layer utilities{.small{font-size:11px}}
button{font-size:12px}</style><button class="small">x</button>`);
console.log(await p.evaluate(()=>getComputedStyle(document.querySelector("button")).fontSize));
await b.close()})()'   # prints 12px: the unlayered rule wins even though it is second
```

## `prettier-plugin-tailwindcss` silently breaks conditional class templates

The plugin treats a template literal in `className` as a class list and sorts it. In doing so it
strips the leading space inside each conditional:

```tsx
<div className={`row${isHead ? " head" : ""}`} />   // written
<div className={`row${isHead ? "head" : ""}`} />    // after `prettier --write`
```

The result is `class="rowhead"`: two class names fused into one that matches no rule. The markup is
valid and meaningless, so nothing warns. It cost two rows of the commit graph and twenty-one
screenshot failures to trace, and it is invisible in review, because the diff is one deleted space.

**What follows from it.** Never build a class list with an interpolated conditional. Pass the parts
as arguments instead, which puts them out of the plugin's reach. That is the whole reason
`src/webview/classes.ts` exists:

```tsx
className={classes("row", isHead && "head", isSelected && "selected")}
```

A literal with no conditional is safe (`` `content il${lane}` `` had no space to lose), but the
distinction is too fine to rely on. Use `classes()` for anything with a branch in it, and prefer a
custom property to a generated class name, which is what replaced that `il<n>` ladder.

Re-check it:

```bash
printf 'export const T=({a}:{a:boolean})=><div className={`row${a?" head":""}`}/>;\n' \
  | bunx prettier --config prettier.config.js --parser typescript | grep className
```

## Tailwind's hover variants are gated on the device being able to hover

`hover:` and `group-hover:` compile inside `@media (hover: hover)`:

```css
@media (hover: hover) {
  .group-hover\:visible:is(:where(.group):hover *) {
    visibility: visible;
  }
}
```

That is the right default for decoration, and wrong when hover is how a control is _reached_. The
file rows keep their actions invisible until hovered, so on a touch device the query fails and the
buttons become permanently unreachable. Hover is being treated as a capability when the requirement
is only "the pointer is over this row".

**An earlier version of this section also claimed headless Chromium fails the query, making the
reveal untestable. That is false**, and worth recording as its own trap: it was the stated reason
for a workaround, and nobody checked it. Under this project's own Playwright configuration,
`(hover: hover)` matches and a gated `group-hover:visible` reveals correctly:

```
headless hover:hover = true
gated button visibility after hover() = visible   # devices["Desktop Chrome"], 1400x1000
```

**What follows from it.** Ungate the variant once, in `src/webview/theme.css`, rather than declaring
a parallel one per group:

```css
@custom-variant hover (&:hover);
```

That covers `hover:`, `group-hover:`, and the named `group-hover/file:` in one line, and the emitted
selectors are otherwise byte-identical, with only the `@media` wrapper gone. The four
`@custom-variant` rules this replaced needed a twelve-line comment, and two of them (`hovered:`,
`group-hovered:`) had no call sites at all. Any reveal-on-hover pattern still needs a focus path,
because a keyboard has no pointer: `IconButton` pairs `group-hover/file:visible` with
`focus-visible:visible`.

Re-check it from the repository root, because the Tailwind CLI resolves `@import "tailwindcss"`
relative to the _input file_ and finds nothing under `/tmp`:

```bash
printf '@import "tailwindcss";\n@source inline("group-hover:visible");\n' > probe.css \
  && bunx @tailwindcss/cli -i probe.css -o /dev/stdout | grep -B1 group-hover \
  ; rm -f probe.css   # the @media wrapper is what to look for
```

## A note on method

None of the traps above was found by looking at a screenshot diff. A picture says a row moved; it
does not say which property moved it. What worked every time was diffing _computed styles_ against
the previous build, taking font size, line height, family, and every box metric for each element in
the region under conversion, then reading the one or two lines that differed:

```js
const grab = sel => {
  const c = getComputedStyle(document.querySelector(sel));
  return {
    fs: c.fontSize,
    lh: c.lineHeight,
    ff: c.fontFamily,
    pad: c.padding /* … */,
  };
};
```

Run it against `HEAD`, set the change aside on a scratch commit, run it again, and compare the two
JSON blobs. That turned "twenty-six screenshots differ" into "`line-height` is 1.5 where it used to
be `normal`" in one step. It also caught one more trap: Tailwind's `leading-normal` is `1.5`, which
is not CSS `normal`, and the two are a whole pixel apart at these sizes. Hence `--leading-auto:
normal` in the theme, and `text-body/auto` wherever a converted rule never set a line-height.

The line height is the whole of that hazard, and the distinction matters. It is Tailwind's *named
sizes* that bundle one, so `text-xs` is 12px **and** 16px of leading, and the utility syntax is not
what does it. So `text-xs/auto` is safe where a bare `text-xs` is not, and the project's own
`--text-*` tokens deliberately define no `--text-*--line-height`, which forces a caller to say which
it wants.
