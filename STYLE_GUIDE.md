# Style guide

The rules a review checks. `eslint.config.mjs` enforces every rule a linter can verify, and each
rule there carries the reason it exists; this document holds the rest, plus the reasoning behind
the enforced ones. Prettier owns layout and import order, so neither is a review topic.

Rules marked **(lint)** fail `just lint`. The others are a reviewer's job.

## Prose

Comments, commit messages, CHANGELOG entries, UI text, and Markdown follow these rules. Clarity
wins where a rule conflicts with it.

- Use active voice, a specific verb, and one idea per sentence.
- Cut filler and hedges: "can", not "is able to".
- Carry only what the code cannot show: the why and non-obvious effects. Cut any sentence a reader
  could recover from the diff.
- Explain each fact once, where it belongs, and point there from elsewhere.
- Describe the code as it is. History belongs in the commit message.
- Do not personify. Code and commands act; data is acted on, and does not want, decide, or know.
- Describe a failure at full strength, with one concrete example.
- Use one term per concept, and do not abbreviate it.

Hard-wrap prose at 100 columns. Leave code blocks, ASCII diagrams, and aligned tables unwrapped,
because wrapping inside them hurts readability. Prettier does not reflow prose inside comments, so
that wrapping is done by hand. Pad table cells so the pipes line up.

### Commit messages

A long commit message goes unread. Use this form, and drop a section with nothing to say:

```md
fix: show the pull request whose head is the branch's tip

## Summary

One or two sentences: the why, and what the diff cannot show.

## Motivation

- One line per problem. `Fixes #12` where an issue exists.

## Test Plan

`just check`. One line on what the new tests cover.
```

Start the subject with `fix:`, `feature:`, or `docs:`. Do not hard-wrap or list new symbols.
A CHANGELOG entry states in a line or two what a user sees change.

## TypeScript

- Never use `any` **(lint)**. It disables checking for the value and spreads to everything the
  value touches. Untyped input gets narrowed instead; `src/ui/actionPayload.ts` is the model.
- Never use `interface` **(lint)**. Interface declarations merge across files, which lets distant
  code silently alter a shape. Declare object shapes with `type`.
- Use a string union, not an `enum` **(lint)**.
- No top-level arrow functions **(lint)**. Declarations hoist, carry their name in stack traces,
  and read as code rather than as data. A closure that captures local state has no declaration
  equivalent, so the rule covers module level only.
- Always use braces **(lint)**. A brace-less body silently excludes the second statement someone
  adds later.
- Use `Number.isFinite` and `Number.isNaN`, never the globals **(lint)**. The globals coerce their
  argument, so `isNaN("")` is `false`.
- Treat an `as` cast as a smell rather than a tool. Work down this list first: fix the upstream
  type, narrow with a type guard, or carry the type through a generic. Reach for `as` last, and
  say in a comment why none of the three worked. Never cast through `unknown`.
- Prefer `Promise.allSettled` to `Promise.all` for independent work. `Promise.all` short-circuits
  on the first rejection and abandons results that had not settled yet.
- Await every promise or discard it explicitly **(lint)**. A dropped promise loses its rejection.
- Name and export a type that another exported type refers to, rather than leaving it reachable
  only through that other type.

## Naming

- No single-letter or abbreviated names. `index` over `i`, `repository` over `repo`.
- A name describes the thing, not its type. `selectedCommit` over `commitObject`.
- Keep related field names consistent across modules, because a reader reads a rename as a
  deliberate distinction.

## Files and functions

- Use named exports, never a default export.
- One exported component per file.
- Put the exported component last, with the helpers it composes above it. The reader meets each
  building block before the thing that uses it, and the file's public surface sits in a
  predictable place.
- Keep a component under roughly 200 lines.
- Pass an options object once a function takes more than about three parameters.
- A helper that returns JSX is a component. Write it as one.
- Use early returns rather than deep nesting.

## Styling

- Tailwind utilities do the styling. `src/webview/graph.css` is the exception: the commit graph
  needs hand-written rules, and it says so.
- Use the theme tokens in `src/webview/theme.css` for colour, size, and spacing. A raw hex value
  or a pixel literal in a component is a token that has not been added yet.
- Prefer `rem` to `px`, since `rem` follows the reader's own font size.
- Prefer `flex`, `grid`, and `gap-*` to margins for spacing between elements. Margins make a
  component harder to place.
- Build a class list with `classes()` from `src/webview/classes.ts`, never by interpolating a
  conditional into a template literal. `LEARNINGS.md` records what the formatter does to the
  second form.
- Fix a layering problem at its source rather than reaching for `!important`. An unlayered
  hand-written rule outranks every Tailwind utility on the same element, which `LEARNINGS.md`
  covers in full.
- Use semantic HTML elements.

## Reporting and errors

- No `console` **(lint)**. The command log panel is where this UI reports what it did. Command-line
  scripts under `scripts/` and `test/` are exempt, because printing is their output.
- Say what a refusal means for the reader, and name what to do next. Every `gh` failure mode in
  `src/github/ghRunner.ts` is a normal state on a plain git repository, not a crash.

## Tests

- Assert a count or a measurement, never "at least one element differs". An assertion that loose
  passes by accident: `LEARNINGS.md` records one that three rows satisfied while 25 were broken.
- A test names the behaviour it protects, not the function it calls.
- The end-to-end suite asserts git state alongside each screenshot. The picture catches a graph
  that draws wrong, the git assertions catch a rewrite that lands wrong, and the assertions are
  what stop a bad picture from being accepted by `just test-e2e-update`.
