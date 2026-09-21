/**
 * Show a described element's text on hover, in an element of our own.
 *
 * The browser's `title` popup was doing this before, badly: it waits about a second,
 * cannot be styled, is drawn outside the page, and — the reason this exists — is
 * invisible to any test, so none of the descriptions could be asserted.
 *
 * Still delegated from the document rather than driven by props. Every described control
 * would otherwise need to route its hover through here, and the components that need it
 * most are the deepest — a file row's icon buttons, a badge inside a pill group. One
 * listener at the root cannot fall out of step with them. The source of the text is
 * `data-tip` when present and `title` otherwise, so a component may use either; `title`
 * is moved onto `data-tip` on first hover, which is what suppresses the native popup
 * underneath.
 */
import { useEffect, useRef, useState } from "react";
import { classes } from "../classes";

/** A delay, so sweeping across a row of buttons does not flash a tooltip for each. */
const TIP_DELAY = 350;

type Placement = { top: number; left: number };

function describedAncestor(node: EventTarget | null): HTMLElement | null {
  for (
    let element = node as HTMLElement | null;
    element && element !== document.body;
    element = element.parentElement
  ) {
    if (element.dataset && (element.dataset.tip || element.title)) {
      return element;
    }
  }
  return null;
}

export function Tooltip() {
  const [text, setText] = useState<string | null>(null);
  const [placement, setPlacement] = useState<Placement>({ top: 0, left: 0 });
  const tip = useRef<HTMLDivElement>(null);
  const target = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const hide = () => {
      clearTimeout(timer.current);
      target.current = null;
      setText(null);
    };

    const show = (element: HTMLElement) => {
      // Moving `title` aside stops the browser drawing its own popup over ours. Kept in
      // `data-tip` so the text is still in the DOM for anything reading descriptions.
      if (element.title) {
        element.dataset.tip = element.title;
        element.removeAttribute("title");
      }
      target.current = element;
      setText(element.dataset.tip ?? null);
    };

    const onMouseOver = (event: MouseEvent) => {
      const element = describedAncestor(event.target);
      if (!element || element === target.current) {
        return;
      }
      hide();
      target.current = element;
      timer.current = setTimeout(() => {
        if (target.current === element) {
          show(element);
        }
      }, TIP_DELAY);
    };

    const onMouseOut = (event: MouseEvent) => {
      if (
        target.current &&
        !target.current.contains(event.relatedTarget as Node | null)
      ) {
        hide();
      }
    };

    // Keyboard users get the same text: focus is their hover, and it shows at once
    // because a keyboard has no equivalent of sweeping past.
    const onFocusIn = (event: FocusEvent) => {
      const element = describedAncestor(event.target);
      if (element) {
        show(element);
      }
    };

    // A tooltip left hanging over a dialog that opened, or after the thing it described
    // was clicked away, is worse than none.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        hide();
      }
    };

    document.addEventListener("mouseover", onMouseOver);
    document.addEventListener("mouseout", onMouseOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", hide);
    document.addEventListener("click", hide);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener("mouseover", onMouseOver);
      document.removeEventListener("mouseout", onMouseOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("click", hide);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  /**
   * Measured after it is shown and filled, since both affect its size. Placed below the
   * element, flipped above when that would leave the viewport, and pulled left when it
   * would overflow the right edge — a tooltip half off screen explains nothing.
   */
  useEffect(() => {
    if (text === null || !tip.current || !target.current) {
      return;
    }
    const box = target.current.getBoundingClientRect();
    const tipBox = tip.current.getBoundingClientRect();
    const below = box.bottom + 6;
    const top =
      below + tipBox.height > window.innerHeight - 4
        ? box.top - tipBox.height - 6
        : below;
    setPlacement({
      top: Math.max(4, top),
      left: Math.max(
        4,
        Math.min(box.left, window.innerWidth - tipBox.width - 4)
      ),
    });
  }, [text]);

  return (
    <div
      id="tip"
      role="tooltip"
      ref={tip}
      // Above every panel and overlay, since it describes controls inside them.
      // `pointer-events-none` keeps it from ever intercepting the click the hover was leading
      // up to.
      className={classes(
        "pointer-events-none fixed z-40 max-w-85 rounded-sm border border-edge bg-card px-2 py-1.25",
        "text-meta/tip text-fg shadow-[0_4px_14px_rgba(0,0,0,0.45)]",
        text === null ? "hidden" : "open block"
      )}
      style={{ top: placement.top, left: placement.left }}
    >
      {text}
    </div>
  );
}
