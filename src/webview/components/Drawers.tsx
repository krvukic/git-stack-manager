/**
 * The design, legend, and shortcuts drawers.
 *
 * All three drop from the top bar over the tree rather than taking a column: each is
 * consulted briefly and dismissed, and stealing width would reflow the graph the reader is
 * trying to compare against. Only one is open at a time — they share the same strip of
 * screen, so opening the second on top of the first would bury it.
 */
import type { UIBranch } from "#ui/renderModel";
import { classes } from "../classes";
import { trunkBehindBadge } from "../model/badges.mjs";
import {
  PILL_FONT_RANGE,
  TEXT_FONT_RANGE,
  type Design,
} from "../model/design.mjs";
import { legendGroups, type LegendRow } from "../model/legend.mjs";
import { SHORTCUTS, SPLITTER_KEYS } from "../model/shortcuts.mjs";
import { Button } from "./Button";
import { FieldLabel } from "./Field";
import { Badge, BranchPills, Pill } from "./Pills";

/** One setting: its label, its control, and the sentence explaining the choice. */
function Group({ children }: { children: React.ReactNode }) {
  return <div className="mb-3.5">{children}</div>;
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-body">{children}</div>;
}

/** The sentence under a control. Narrow enough to read, which is why it takes a max width. */
function Hint({ children }: { children: React.ReactNode }) {
  return <div className="mt-0.75 text-meta text-muted">{children}</div>;
}

export const DRAWERS = ["design", "legend", "keys"] as const;
export type DrawerName = (typeof DRAWERS)[number];

function Drawer({
  name,
  title,
  isOpen,
  onClose,
  children,
}: {
  name: DrawerName;
  title: string;
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    /*
      Two thirds of the height rather than a half: the legend covers six groups, and a shorter
      drawer hid the review glyphs below its own fold — the rows a reader opened it for. It
      scrolls internally, so the tree always keeps the remaining third.
    */
    <div
      id={name}
      className={classes(
        "drawer max-h-[66%] flex-none overflow-y-auto border-b border-b-edge bg-card px-4 py-3",
        isOpen ? "open block" : "hidden"
      )}
    >
      {/* Floated rather than positioned, so the heading beside it keeps the full width and a
          long one wraps under the button instead of behind it. */}
      <Button
        size="small"
        className="float-right"
        id={`btn-${name}-close`}
        onClick={onClose}
      >
        Close
      </Button>
      <FieldLabel as="h3" heading className="mb-2 font-semibold">
        {title}
      </FieldLabel>
      {children}
    </div>
  );
}

/**
 * A headed table of rows: the legend's badge explanations and the shortcuts' key caps.
 *
 * A table rather than a flex grid because the columns must line up down the whole group — the
 * reader scans the sentences, not the samples beside them. The gap after each cell is the one
 * thing the two callers disagree on, and each says why where it passes it.
 */
function TableSection({
  heading,
  cellGap,
  children,
}: {
  heading: string;
  cellGap: "[&_td]:pr-2" | "[&_td]:pr-3";
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3.5">
      <FieldLabel as="h3" heading className="mb-2 font-semibold">
        {heading}
      </FieldLabel>
      <table
        className={classes(
          "border-collapse [&_td]:py-0.75 [&_td]:align-middle",
          cellGap
        )}
      >
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** A two-choice control. Both options stay visible, so the alternative is discoverable. */
function Segmented<T extends string>({
  id,
  options,
  value,
  attribute,
  onChange,
}: {
  id: string;
  options: { value: T; label: string }[];
  value: T;
  /** The `data-` attribute the end-to-end suite selects each button by. */
  attribute: string;
  onChange: (value: T) => void;
}) {
  return (
    // `overflow-hidden` on the group is what clips the buttons' corners to the group's radius,
    // so the pair reads as one control rather than two.
    <div
      className="seg inline-flex overflow-hidden rounded-sm border border-edge"
      id={id}
    >
      {options.map(option => (
        <button
          key={option.value}
          className={classes(
            "cursor-pointer px-3 py-1 text-meta/auto",
            // A hairline between the choices, but not before the first.
            "[&+&]:border-l [&+&]:border-l-edge",
            option.value === value
              ? "on bg-button text-button-fg"
              : "bg-transparent text-fg"
          )}
          {...{ [`data-${attribute}`]: option.value }}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SizeSlider({
  id,
  value,
  range,
  hint,
  onChange,
}: {
  id: string;
  value: number;
  range: { min: number; max: number };
  hint: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {/*
        `onChange` fires per keystroke of the slider, which is what restyles the tree as it
        moves — the only way to judge a text size, since the sample is the graph itself.
      */}
      <input
        type="range"
        className="w-45 accent-accent"
        id={`rng-${id}`}
        min={range.min}
        max={range.max}
        step={1}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
      />
      {/* A minimum width, so the row does not shift as the number goes from 9px to 10px. */}
      <span
        className="min-w-8.5 font-[monospace] text-meta text-muted"
        id={`val-${id}`}
      >{`${value}px`}</span>
      <Hint>{hint}</Hint>
    </div>
  );
}

export function DesignDrawer({
  isOpen,
  design,
  onChange,
  onReset,
  onClose,
}: {
  isOpen: boolean;
  design: Design;
  onChange: (changes: Partial<Design>) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  return (
    <Drawer name="design" title="Design" isOpen={isOpen} onClose={onClose}>
      <Group>
        <GroupLabel>Branch pills and badges</GroupLabel>
        <Segmented
          id="seg-pillside"
          attribute="side"
          value={design.pillSide}
          options={[
            { value: "left", label: "Before the subject" },
            { value: "right", label: "After the subject" },
          ]}
          onChange={pillSide => onChange({ pillSide })}
        />
        <Hint>
          After the subject lines every commit message up on one left edge, so
          the column reads as a list; each row&apos;s pills follow its own
          subject.
        </Hint>
      </Group>
      <Group>
        <GroupLabel>Clicking a file name</GroupLabel>
        <Segmented
          id="seg-fileclick"
          attribute="fileclick"
          value={design.fileClick}
          options={[
            { value: "file", label: "Opens the current file" },
            { value: "diff", label: "Opens its diff" },
          ]}
          onChange={fileClick => onChange({ fileClick })}
        />
        <Hint>
          Applies to the file list under a selected commit. Either way both
          buttons above that list stay available, so the choice is only about
          the shortcut.
        </Hint>
      </Group>
      <Group>
        <GroupLabel>Long rows</GroupLabel>
        <Segmented
          id="seg-wraprows"
          attribute="wrap"
          value={design.wrapRows ? "on" : "off"}
          options={[
            { value: "off", label: "Keep to one line" },
            { value: "on", label: "Wrap onto more lines" },
          ]}
          onChange={wrap => onChange({ wrapRows: wrap === "on" })}
        />
        <Hint>
          One line truncates a subject that will not fit, so every row is the
          same height. Wrapping shows all of it and grows the row to match —
          useful in a narrow tree, once the commit panel has taken most of the
          width.
        </Hint>
      </Group>
      <Group>
        <GroupLabel>Text size</GroupLabel>
        <SizeSlider
          id="text"
          value={design.textFont}
          range={TEXT_FONT_RANGE}
          hint="Commit subjects, hashes, and hints."
          onChange={textFont => onChange({ textFont })}
        />
      </Group>
      <Group>
        <GroupLabel>Branch pill and badge size</GroupLabel>
        <SizeSlider
          id="pill"
          value={design.pillFont}
          range={PILL_FONT_RANGE}
          hint="Branch names, sync badges, and pull request badges."
          onChange={pillFont => onChange({ pillFont })}
        />
      </Group>
      <Group>
        <Button id="btn-design-reset" onClick={onReset}>
          Restore defaults
        </Button>
      </Group>
    </Drawer>
  );
}

/**
 * One row's sample, drawn by whichever component owns it in the tree.
 *
 * Trunk's behind badge is built here rather than in `legend.mts`, which the unit suite
 * loads as source: node strips its types instead of compiling it, and a value import of a
 * sibling `.mts` module does not resolve under that. The legend carries the arguments; the
 * badge itself comes from the same function the trunk row calls.
 */
function LegendSample({
  row,
  onOpenUrl,
}: {
  row: LegendRow;
  onOpenUrl: (url: string) => void;
}) {
  if (row.pill) {
    return <Pill label={row.pill.label} variant={row.pill.variant} />;
  }
  if (row.trunkBehind) {
    const { branch, behind, trunkRef, isCheckedOut } = row.trunkBehind;
    const badge = trunkBehindBadge(branch, behind, trunkRef, isCheckedOut);
    return badge ? <Badge {...badge} /> : null;
  }
  return <BranchPills branch={row.branch as UIBranch} onOpenUrl={onOpenUrl} />;
}

/**
 * Every sample is built by the same components that draw the tree, from a real branch
 * detail, so a badge whose colour or glyph changes cannot go on being explained the old
 * way here.
 *
 * The samples carry real pull request badges, which are clickable in the tree. Here they
 * have no URL, so `onOpenUrl` is a no-op — left unwired on purpose rather than opening
 * nothing.
 */
export function LegendDrawer({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const noop = () => {};
  return (
    <Drawer name="legend" title="Legend" isOpen={isOpen} onClose={onClose}>
      <div id="legend-body">
        {legendGroups().map(group => (
          <TableSection
            heading={group.heading}
            cellGap="[&_td]:pr-2"
            key={group.heading}
          >
            {group.rows.map(row => (
              <tr key={row.what}>
                <td className="whitespace-nowrap">
                  <LegendSample row={row} onOpenUrl={noop} />
                </td>
                <td className="text-body">{row.what}</td>
                <td className="text-meta text-muted">{row.why}</td>
              </tr>
            ))}
          </TableSection>
        ))}
      </div>
    </Drawer>
  );
}

export function ShortcutsDrawer({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      name="keys"
      title="Keyboard shortcuts"
      isOpen={isOpen}
      onClose={onClose}
    >
      <div id="keys-body">
        {SHORTCUTS.map(group => (
          // Wider cells than the legend's: a row of key caps needs more air between the caps
          // and the sentence than a single badge does.
          <TableSection
            heading={group.heading}
            cellGap="[&_td]:pr-3"
            key={group.heading}
          >
            {(group.keys.length ? group.keys : SPLITTER_KEYS).map(shortcut => (
              <tr key={shortcut.what}>
                <td className="whitespace-nowrap">
                  {/*
                    Joined by a space, because two key caps with nothing between them touch:
                    `↑ k` reads as alternatives, `↑k` as a chord.
                  */}
                  {shortcut.keys.map((key, index) => (
                    <span key={key}>
                      {index > 0 ? " " : null}
                      <kbd className="inline-block min-w-5 rounded-sm border border-b-2 border-edge bg-input px-1.5 py-px text-center font-[monospace] text-meta/key text-fg">
                        {key}
                      </kbd>
                    </span>
                  ))}
                </td>
                <td className="text-body">{shortcut.what}</td>
              </tr>
            ))}
          </TableSection>
        ))}
        {/*
          Typing into the message editor must never trigger these, which is the one rule that is
          easier to state than to see in the table. A max width because this is a paragraph: a
          line running the drawer's full width is hard to track back to its start.
        */}
        <div className="max-w-160 text-meta text-muted">
          Keys are ignored while a text field has focus, so the message editor
          and the commit form work normally. Navigation skips the trunk tip,
          bases, and hidden-commit rows, since only commits have actions.
        </div>
      </div>
    </Drawer>
  );
}
