/**
 * The text inputs, their labels, and the uppercase heading those labels share with the
 * drawers, the command log, the absorb preview, and the context menu.
 *
 * Three panels write a commit message — the working copy's commit form, the commit panel's
 * editor, and the split panel's two subjects — and each had its own copy of the same box.
 * These are that box.
 *
 * `font-[monospace]` on the multi-line ones and not the single-line ones is deliberate: a
 * subject is prose read at a glance, while a body is wrapped at 72 columns by convention and a
 * proportional font makes that column impossible to judge.
 */
import { classes } from "../classes";

/**
 * A field's label. Plain by default; `heading` is the tracked-out uppercase form.
 *
 * The two are genuinely different, not one with an override. The commit panel's labels are
 * section headings — *MESSAGE*, *FILES CHANGED* — set uppercase and tracked out so they read as
 * furniture. The commit form's sit inline in a compact block where uppercase would shout, and
 * they were never styled that way.
 *
 * The uppercase form is not only a form label: a drawer's title, a menu's section head, and the
 * absorb preview's caption are the same piece of furniture, which is what `as` is for. Margin
 * and weight vary per site and come through `className`; the heading itself carries none, so a
 * caption that sits tight against its list stays tight.
 */
export function FieldLabel({
  as: Tag = "label",
  children,
  className,
  heading = false,
}: {
  as?: "label" | "div" | "span" | "h3";
  children: React.ReactNode;
  className?: string;
  heading?: boolean;
}) {
  return (
    <Tag
      className={classes(
        "text-meta text-muted",
        heading && "tracking-caps uppercase",
        // A label is inline, so the vertical margin the commit panel gives its headings would
        // do nothing. The other elements here are block-level already.
        heading && Tag === "label" && "block",
        className
      )}
    >
      {children}
    </Tag>
  );
}

const FIELD_BOX =
  "w-full rounded-sm border bg-input text-input-fg font-[inherit]";

export function TextInput({
  className,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={classes(FIELD_BOX, "border-input-edge px-2 py-1.5", className)}
      {...rest}
    />
  );
}

/**
 * `resize-y` and a minimum height rather than a fixed one: the grip is a real affordance here
 * — the commit panel's description can be double-clicked to fit its text — and a pinned height
 * would fight it.
 */
export function TextArea({
  className,
  ref,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** The commit panel measures its own box to fit the text; see its resize grip. */
  ref?: React.Ref<HTMLTextAreaElement>;
}) {
  return (
    <textarea
      ref={ref}
      className={classes(
        FIELD_BOX,
        "resize-y border-input-edge px-2 py-1.5 font-[monospace]",
        className
      )}
      {...rest}
    />
  );
}

/**
 * The centred, dimmed message a panel shows in place of content it has none of.
 *
 * Two of them — the tree with no local branches, and the first load before a model arrives —
 * and both carry `id="empty"`, which the end-to-end suite reads. They were byte-identical
 * copies, so only one could ever render without putting a duplicate id in the document.
 */
export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div id="empty" className="p-7.5 text-center text-muted">
      {children}
    </div>
  );
}
