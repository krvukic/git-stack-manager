/**
 * The right-click menu on a commit.
 *
 * Sapling opens one on each commit, and the rebase entries live there rather than in the
 * commit panel so the destination reads next to the commit it applies to.
 *
 * An item without `run` renders as an explanatory disabled row — which is how "Rebase —
 * finish the conflict first" says why it cannot be used, rather than the entry simply
 * vanishing.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { classes } from "../classes";
import { FieldLabel } from "./Field";

export type MenuItem =
  | { separator: true }
  | { head: string }
  | { label: string; description?: string; run?: () => void };

export type MenuState = { x: number; y: number; items: MenuItem[] } | null;

export function ContextMenu({
  menu,
  onClose,
}: {
  menu: MenuState;
  onClose: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState({ left: 0, top: 0 });

  /**
   * Place inside the viewport: flip past the pointer when the menu would overflow the right
   * or bottom edge. Measured after it is filled, since its size depends on the items.
   */
  useLayoutEffect(() => {
    if (!menu || !element.current) {
      return;
    }
    const { width, height } = element.current.getBoundingClientRect();
    setPlacement({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - height - 8)),
    });
  }, [menu]);

  /**
   * Dismiss the menu on anything that means "not this menu": a press outside it, the
   * page scrolling or resizing under it, or the window losing focus.
   *
   * The press is what was missing. Every other menu on the platform closes when you
   * click past it, so a menu that only closed on an item or on Escape stayed on screen
   * through a whole sequence of clicks elsewhere — selecting rows, opening a diff — and
   * went on pointing at the commit it was opened over.
   *
   * `pointerdown` in the capture phase, so it fires before the row under the pointer
   * handles the click and the menu is gone by the time that row's panel opens. A
   * right-click *starts* with a pointerdown too, which closes this menu before `Tree`
   * opens the next one — the two state writes land in one render, leaving the new menu.
   */
  useLayoutEffect(() => {
    if (!menu) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!element.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const tree = document.getElementById("tree");
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    tree?.addEventListener("scroll", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      tree?.removeEventListener("scroll", onClose);
    };
  }, [menu, onClose]);

  return (
    <div
      id="menu"
      ref={element}
      // `fixed` and a z-index above the panels: the menu is placed at the pointer, which can be
      // anywhere, and it has to sit over whatever it was opened on top of.
      className={classes(
        "fixed z-20 min-w-60 rounded-card border border-edge bg-card p-1",
        "shadow-[0_4px_16px_rgba(0,0,0,0.4)]",
        // `open` carries no styling; the end-to-end suite waits on `#menu.open`.
        menu ? "open block" : "hidden"
      )}
      style={{ left: placement.left, top: placement.top }}
    >
      {menu?.items.map((item, index) => {
        if ("separator" in item) {
          return <div className="mx-0.5 my-1 h-px bg-edge" key={index} />;
        }
        if ("head" in item) {
          // The horizontal padding is the items' own, so the head's first letter sits on the
          // same left edge as the labels under it rather than hanging outside them.
          return (
            <FieldLabel as="div" heading className="px-2 py-1" key={index}>
              {item.head}
            </FieldLabel>
          );
        }
        return (
          <div
            key={index}
            // An item without `run` is an explanation rather than an action — "Rebase — finish
            // the conflict first" — so it is dimmed and takes no hover.
            className={classes(
              "item rounded-sm px-2 py-1.5 whitespace-nowrap",
              item.run
                ? "cursor-pointer hover:bg-button-2"
                : "cursor-default text-muted"
            )}
            title={item.description}
            onClick={
              item.run
                ? () => {
                    onClose();
                    item.run!();
                  }
                : undefined
            }
          >
            {item.label}
          </div>
        );
      })}
    </div>
  );
}
