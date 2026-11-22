/**
 * The Config drawer: every preference the reader can set over the tree.
 *
 * Each choice is a preference rather than a repository fact, so `storage.ts` keeps it in
 * webview state rather than in VS Code's settings. `model/config.mjs` owns the shape, and says
 * why a choice has to outlive the page.
 */
import { classes } from "../classes";
import {
  PILL_FONT_RANGE,
  PILL_MAX_CHARS_RANGE,
  TEXT_FONT_RANGE,
  type Config,
} from "../model/config.mjs";
import { Button } from "./Button";
import { Drawer } from "./Drawer";

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

/**
 * A slider and the value it is on.
 *
 * `readout` arrives formatted, and `Slider` appends no unit of its own. The character cap is
 * why: at the top of its range it reads *No limit* rather than a number, which no appended
 * unit could produce.
 */
function Slider({
  id,
  value,
  readout,
  range,
  hint,
  onChange,
}: {
  id: string;
  value: number;
  readout: string;
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
      >
        {readout}
      </span>
      <Hint>{hint}</Hint>
    </div>
  );
}

export function ConfigDrawer({
  isOpen,
  config,
  onChange,
  onReset,
  onClose,
}: {
  isOpen: boolean;
  config: Config;
  onChange: (changes: Partial<Config>) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  return (
    <Drawer name="config" title="Config" isOpen={isOpen} onClose={onClose}>
      <Group>
        <GroupLabel>Branch pills and badges</GroupLabel>
        <Segmented
          id="seg-pillside"
          attribute="side"
          value={config.pillSide}
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
          value={config.fileClick}
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
        <GroupLabel>New pull requests</GroupLabel>
        <Segmented
          id="seg-draftdefault"
          attribute="draftdefault"
          value={config.draftByDefault ? "on" : "off"}
          options={[
            { value: "off", label: "Ready for review" },
            { value: "on", label: "Draft" },
          ]}
          onChange={choice => onChange({ draftByDefault: choice === "on" })}
        />
        <Hint>
          The state Submit opens a new pull request in. The Draft toggle in the
          commit panel overrides it for one branch. Submit never changes the
          state of a pull request that is already open.
        </Hint>
      </Group>
      <Group>
        <GroupLabel>Auto-remove merged commits</GroupLabel>
        <Segmented
          id="seg-deletemerged"
          attribute="deletemerged"
          value={config.deleteMergedBranches ? "on" : "off"}
          options={[
            { value: "off", label: "Keep the branch" },
            { value: "on", label: "Delete the local branch" },
          ]}
          onChange={choice =>
            onChange({ deleteMergedBranches: choice === "on" })
          }
        />
        <Hint>
          Deleting takes the branch and its commits out of the tree. Only a
          branch still at the commit its pull request merged goes, so one you
          amended or added to afterwards stays, as does the checked-out branch.
          Undo brings a deleted branch back.
        </Hint>
        <Hint>
          Removal runs when the tree learns a pull request merged, which is when
          this view opens and when Refresh runs — not on its own while it sits
          open.
        </Hint>
      </Group>
      <Group>
        <GroupLabel>Commit date</GroupLabel>
        <Segmented
          id="seg-showdate"
          attribute="showdate"
          value={config.showDate ? "on" : "off"}
          options={[
            { value: "off", label: "Hide" },
            { value: "on", label: "Show beside the hash" },
          ]}
          onChange={choice => onChange({ showDate: choice === "on" })}
        />
        <Hint>
          Work from the last day reads as an age — 20 seconds ago, 5 minutes
          ago, 2 hours ago — and anything older as its date, because a count of
          months is a number nobody can turn back into a day. Only commit rows
          carry a date; the trunk and base rows are drawn for position.
        </Hint>
      </Group>
      <Group>
        <GroupLabel>Lines changed</GroupLabel>
        <Segmented
          id="seg-linecounts"
          attribute="linecounts"
          value={config.showLineCounts ? "on" : "off"}
          options={[
            { value: "off", label: "Hide" },
            { value: "on", label: "Show beside the hash" },
          ]}
          onChange={choice => onChange({ showLineCounts: choice === "on" })}
        />
        <Hint>
          The lines each commit added and removed, such as +12 −3. Git counts
          them by diffing the commit, so nothing is counted while this is
          hidden, and each commit is counted once.
        </Hint>
      </Group>
      <Group>
        <GroupLabel>Other authors&apos; commits</GroupLabel>
        <Segmented
          id="seg-dimothers"
          attribute="dimothers"
          value={config.dimOtherAuthors ? "on" : "off"}
          options={[
            { value: "off", label: "Show as usual" },
            { value: "on", label: "Dim" },
          ]}
          onChange={choice => onChange({ dimOtherAuthors: choice === "on" })}
        />
        <Hint>
          Dims a commit whose author email differs from git config user.email,
          and adds the author to its tooltip. Off by default, so a shared branch
          does not look broken.
        </Hint>
      </Group>
      <Group>
        <GroupLabel>Long rows</GroupLabel>
        <Segmented
          id="seg-wraprows"
          attribute="wrap"
          value={config.wrapRows ? "on" : "off"}
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
        <Slider
          id="text"
          value={config.textFont}
          readout={`${config.textFont}px`}
          range={TEXT_FONT_RANGE}
          hint="Commit subjects, hashes, and hints."
          onChange={textFont => onChange({ textFont })}
        />
      </Group>
      <Group>
        <GroupLabel>Branch pill and badge size</GroupLabel>
        <Slider
          id="pill"
          value={config.pillFont}
          readout={`${config.pillFont}px`}
          range={PILL_FONT_RANGE}
          hint="Branch names, sync badges, and pull request badges."
          onChange={pillFont => onChange({ pillFont })}
        />
      </Group>
      <Group>
        <GroupLabel>Branch pill and badge length</GroupLabel>
        <Slider
          id="pillchars"
          value={config.pillMaxChars}
          readout={
            config.pillMaxChars >= PILL_MAX_CHARS_RANGE.max
              ? "No limit"
              : `${config.pillMaxChars}`
          }
          range={PILL_MAX_CHARS_RANGE}
          hint="Characters a pill or badge shows before it is clipped."
          onChange={pillMaxChars => onChange({ pillMaxChars })}
        />
        <Hint>
          A 30-character branch name and the diverged badge repeating it can
          take a narrow row entirely, leaving nothing for the commit message.
          The full name stays on hover, and the pull request badge is never
          clipped — its glyphs are the point of it.
        </Hint>
      </Group>
      <Group>
        <Button id="btn-config-reset" onClick={onReset}>
          Restore defaults
        </Button>
      </Group>
    </Drawer>
  );
}
