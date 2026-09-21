/**
 * One row's rail gutter, as SVG.
 *
 * The SVG is exactly one row tall and absolutely positioned, so segments meet seamlessly
 * at row boundaries. `railGeometry` decides every coordinate; this only turns them into
 * elements, which is why the geometry is unit tested and this is not.
 */
import type { Rails } from "../graph/rails.mjs";

export function RailGutter({ rails }: { rails: Rails }) {
  return (
    <svg
      className="rail"
      width={rails.width}
      height={rails.height}
      viewBox={`0 0 ${rails.width} ${rails.height}`}
    >
      {rails.lines.map((line, index) => (
        <line
          key={`line-${index}`}
          x1={line.x}
          y1={line.y1}
          x2={line.x}
          y2={line.y2}
        />
      ))}
      {rails.curves.map((curve, index) => (
        <path
          key={`curve-${index}`}
          d={`M ${curve.fromX} 0 C ${curve.toX} 0, ${curve.toX} ${curve.turnY}, ${curve.toX} ${curve.endY}`}
        />
      ))}
      {rails.node?.haloRadius ? (
        <circle
          className="halo"
          cx={rails.node.cx}
          cy={rails.node.cy}
          r={rails.node.haloRadius}
        />
      ) : null}
      {rails.node ? (
        <circle
          className={
            rails.node.variant === "plain"
              ? "node"
              : `node ${rails.node.variant}`
          }
          cx={rails.node.cx}
          cy={rails.node.cy}
          r={rails.node.radius}
        />
      ) : null}
    </svg>
  );
}

/**
 * Carry each through-line past the drawn SVG, for when wrapping makes the row taller.
 *
 * Stretching the SVG instead would letterbox its viewBox and float the dot away from the
 * first line's text, since `preserveAspectRatio` centres content in a taller box. These
 * collapse to zero height on a single-line row, so they cost nothing when wrapping is off.
 */
export function RailFillers({ centres }: { centres: number[] }) {
  return (
    <>
      {centres.map(centre => (
        <div key={centre} className="railfill" style={{ left: centre - 1 }} />
      ))}
    </>
  );
}
