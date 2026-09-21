/**
 * Where each hunk would land, before anything is rewritten.
 *
 * Absorb's whole value is that the placement is inspectable, and a wrong guess is quiet
 * rather than loud — so the preview is the confirmation step.
 */

import { Button, ButtonRow } from "./Button";
import { FieldLabel } from "./Field";

export type AbsorbTarget = { sha: string; subject: string; hunks: number };
export type AbsorbSkip = { path: string; reason: string };

/** `null` while closed; `loading` covers the round trip that works out placement. */
export type AbsorbPlan =
  | { state: "loading" }
  | { state: "error"; error: string }
  | { state: "ready"; targets: AbsorbTarget[]; skipped: AbsorbSkip[] };

/** The card every state draws inside, so the box cannot drift between them. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      id="absorb-preview"
      className="mt-2 ml-2 rounded-card border border-edge bg-card p-2"
    >
      {children}
    </div>
  );
}

function Title() {
  return (
    <FieldLabel as="div" heading>
      Absorb
    </FieldLabel>
  );
}

/** A change that could not be placed, and why. Amber, because it is a partial outcome. */
function Skip({ children }: { children: React.ReactNode }) {
  return <div className="text-meta text-mod">{children}</div>;
}

export function AbsorbPreview({
  plan,
  applying,
  onApply,
  onCancel,
}: {
  plan: AbsorbPlan | null;
  applying: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  if (!plan) {
    return <div id="absorb-preview" />;
  }
  if (plan.state === "loading") {
    return (
      <Shell>
        <Title />
        <div className="text-muted">Working out placement…</div>
      </Shell>
    );
  }
  if (plan.state === "error") {
    return (
      <Shell>
        <Title />
        <Skip>{plan.error}</Skip>
      </Shell>
    );
  }
  // Nothing placeable: say so, and still list what was skipped and why — that list is the
  // only explanation the reader gets for an absorb that would do nothing.
  if (!plan.targets.length) {
    return (
      <Shell>
        <Title />
        <Skip>Nothing can be placed automatically.</Skip>
        {plan.skipped.map(entry => (
          <Skip key={entry.path}>{`${entry.path} — ${entry.reason}`}</Skip>
        ))}
      </Shell>
    );
  }
  return (
    <Shell>
      <FieldLabel as="div" heading>
        Absorb into
      </FieldLabel>
      {plan.targets.map(target => (
        <div className="flex items-center gap-2 py-0.5" key={target.sha}>
          <span className="flex-none font-[monospace] text-meta text-accent">
            {`${target.hunks}×`}
          </span>
          {/*
            The sha and subject are styled here rather than inherited. They used to pick up the
            tree's own `.sha` and `.subject` rules, which now live on the row components — a
            preview line is not a row, so it says what it wants.
          */}
          <span className="flex-none font-[monospace] text-meta/none text-muted">
            {target.sha.slice(0, 8)}
          </span>
          <span className="truncate text-ui/none">{target.subject}</span>
        </div>
      ))}
      {plan.skipped.map(entry => (
        <Skip key={entry.path}>
          {`Left in working copy: ${entry.path} — ${entry.reason}`}
        </Skip>
      ))}
      <ButtonRow className="mt-2">
        <Button
          id="btn-absorb-apply"
          variant="primary"
          disabled={applying}
          onClick={onApply}
        >
          {applying ? "Absorbing…" : "Absorb"}
        </Button>
        <Button id="btn-absorb-cancel" onClick={onCancel}>
          Cancel
        </Button>
      </ButtonRow>
    </Shell>
  );
}
