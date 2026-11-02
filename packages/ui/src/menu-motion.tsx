import type { JSX } from "@solidjs/web";
import { onCleanup, onSettled } from "solid-js";
import { prefersReducedMotion } from "./utils";

// Kobalte removes the content of a menu or a popover at once when it closes, so a CSS exit
// animation cannot play. When the content closes, an inert copy takes its place and plays the exit
// that the stylesheet gives to content without data-expanded.
//
const EXIT_FALLBACK_MS = 400;

/** The scroll offsets of a copy, by the index of the element in the copy. A clone does not keep them. */
const scrollOffsets = new WeakMap<HTMLElement, Array<[index: number, top: number, left: number]>>();

/** Puts a copy on the page, and gives back the scroll offsets that the insertion resets. */
function insertCopy(copy: HTMLElement, parent: Node): void {
  parent.appendChild(copy);
  const offsets = scrollOffsets.get(copy);
  if (!offsets) return;
  const elements = copy.querySelectorAll("*");
  for (const [index, top, left] of offsets) {
    const element = elements[index];
    if (!element) continue;
    element.scrollTop = top;
    element.scrollLeft = left;
  }
}

function motionAllowed(element: HTMLElement): boolean {
  return typeof element.animate === "function" && !prefersReducedMotion();
}

function positionerOf(panel: HTMLElement): HTMLElement | null {
  return panel.closest<HTMLElement>("[data-popper-positioner]");
}

function playExit(copy: HTMLElement, panel: HTMLElement): void {
  delete panel.dataset.menuHold;
  // Content with no exit animation in the stylesheet goes at once.
  if (panel.getAnimations().length === 0) {
    copy.remove();
    return;
  }
  const fallback = setTimeout(() => copy.remove(), EXIT_FALLBACK_MS);
  panel.addEventListener(
    "animationend",
    () => {
      clearTimeout(fallback);
      copy.remove();
    },
    { once: true },
  );
}

/** Puts an inert copy of closed content in its place and plays its exit. */
function leave(panel: HTMLElement, place: Node | null): void {
  const positioner = positionerOf(panel);
  if (!positioner) return;
  // The copy is made now, while the content is still whole.
  const copy = positioner.cloneNode(true);
  if (!(copy instanceof HTMLElement)) return;
  const offsets: Array<[number, number, number]> = [];
  for (const [index, element] of Array.from(positioner.querySelectorAll("*")).entries()) {
    if (element.scrollTop !== 0 || element.scrollLeft !== 0)
      offsets.push([index, element.scrollTop, element.scrollLeft]);
  }
  if (offsets.length > 0) scrollOffsets.set(copy, offsets);
  const copyPanel = panel.id ? copy.querySelector<HTMLElement>(`#${CSS.escape(panel.id)}`) : null;
  if (!copyPanel) return;
  copy.inert = true;
  copy.setAttribute("aria-hidden", "true");
  copy.style.pointerEvents = "none";
  for (const element of copy.querySelectorAll("[id]")) element.removeAttribute("id");
  copyPanel.removeAttribute("data-expanded");
  delete copyPanel.dataset.menuSwapIn;

  // The cleanup can run before the content leaves the page. Solid removes it in the same pass, so
  // the copy goes in after that pass and before the next paint.
  queueMicrotask(() => {
    if (positioner.isConnected) {
      return;
    }
    // Content without a portal goes back into its parent, so that its position stays right.
    insertCopy(copy, place?.isConnected ? place : document.body);
    playExit(copy, copyPanel);
  });
}

/**
 * Gives menu content its exit animation. Submenu handoff is intentionally left to Kobalte so rapid
 * pointer movement does not clone and animate overlapping panels on top of one another.
 */
export function useMenuMotion(options: { waitForPlacement?: boolean } = {}): (element: HTMLElement) => void {
  let panel: HTMLElement | undefined;
  let place: Node | null = null;
  let placementObserver: MutationObserver | undefined;
  let placementFrame: number | undefined;
  onCleanup(() => {
    placementObserver?.disconnect();
    if (placementFrame !== undefined) cancelAnimationFrame(placementFrame);
    if (panel && motionAllowed(panel)) leave(panel, place);
  });
  return (element) => {
    panel = element;
    if (options.waitForPlacement) {
      const positioner = positionerOf(element);
      if (positioner) {
        element.dataset.menuPositionPending = "";
        placementObserver?.disconnect();
        let previousTransform: string | null = null;
        let stableFrames = 0;
        const checkPlacement = () => {
          placementFrame = undefined;
          if (!element.isConnected || !positioner.isConnected) return;
          const transform = positioner.style.transform;
          if (!transform.startsWith("translate3d(")) {
            previousTransform = null;
            stableFrames = 0;
          } else if (transform === previousTransform) {
            stableFrames += 1;
          } else {
            previousTransform = transform;
            stableFrames = 0;
          }
          if (stableFrames >= 2) {
            delete element.dataset.menuPositionPending;
            placementObserver?.disconnect();
            placementObserver = undefined;
            return;
          }
          placementFrame = requestAnimationFrame(checkPlacement);
        };
        const schedulePlacementCheck = () => {
          if (placementFrame === undefined) placementFrame = requestAnimationFrame(checkPlacement);
        };
        placementObserver = new MutationObserver(schedulePlacementCheck);
        placementObserver.observe(positioner, { attributes: true, attributeFilter: ["style"] });
        schedulePlacementCheck();
      }
    }
    if (!motionAllowed(element)) return;
    requestAnimationFrame(() => {
      if (!element.isConnected) return;
      place = positionerOf(element)?.parentNode ?? null;
    });
  };
}

/**
 * The exit animation for content that has no portal, such as a popover in place. Put it among the
 * children of the content, because the children close with the content and the wrapper does not.
 */
export function ContentExitMotion(props: { panel: () => HTMLElement | undefined }): JSX.Element {
  const attach = useMenuMotion();
  onSettled(() => {
    const panel = props.panel();
    if (panel) attach(panel);
  });
  return undefined;
}
