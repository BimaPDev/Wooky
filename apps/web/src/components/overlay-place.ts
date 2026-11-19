export type Side = "above" | "below";

export type AnchorBox = {
  top: number;
  bottom: number;
  left: number;
  width: number;
};

const GAP = 6;
const MARGIN = 8;

/**
 * Prefer `placement` unless that side has less than `minRoom` and the other side has more.
 * Shared by popovers and tooltips so both stay on screen the same way.
 */
export function chooseSide(
  anchor: Pick<AnchorBox, "top" | "bottom">,
  viewportHeight: number,
  placement: Side,
  minRoom: number,
): Side {
  const above = anchor.top;
  const below = viewportHeight - anchor.bottom;
  const preferred = placement === "above" ? above : below;
  const other = placement === "above" ? below : above;
  if (preferred < minRoom && other > preferred) {
    return placement === "above" ? "below" : "above";
  }
  return placement;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** Place a tooltip under the anchor, flipping above or shifting sideways so it stays on screen. */
export function placeTooltip(
  anchor: AnchorBox,
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
  placement: Side = "below",
): { top: number; left: number; side: Side } {
  const side = chooseSide(anchor, viewport.height, placement, tip.height + GAP + MARGIN);
  const rawTop = side === "below" ? anchor.bottom + GAP : anchor.top - GAP - tip.height;
  const top = clamp(rawTop, MARGIN, Math.max(MARGIN, viewport.height - tip.height - MARGIN));
  const rawLeft = anchor.left + anchor.width / 2 - tip.width / 2;
  const left = clamp(rawLeft, MARGIN, Math.max(MARGIN, viewport.width - tip.width - MARGIN));
  return { top: Math.round(top), left: Math.round(left), side };
}
