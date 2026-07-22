export type GraphPoint = { x: number; y: number };

export const RESEARCH_CITATION_MARKER_BUFFER = 8;

export function directedEdgeEndpoints(
  source: GraphPoint,
  target: GraphPoint,
  sourceRadius: number,
  targetRadius: number,
  markerBuffer = RESEARCH_CITATION_MARKER_BUFFER,
): { source: GraphPoint; target: GraphPoint } {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance <= 0) return { source, target };
  const unitX = dx / distance;
  const unitY = dy / distance;
  const startOffset = Math.max(0, Math.min(sourceRadius, distance / 2));
  const requestedEndOffset = Math.max(0, targetRadius + markerBuffer);
  const endOffset = Math.max(0, Math.min(requestedEndOffset, distance - startOffset));
  return {
    source: {
      x: source.x + unitX * startOffset,
      y: source.y + unitY * startOffset,
    },
    target: {
      x: target.x - unitX * endOffset,
      y: target.y - unitY * endOffset,
    },
  };
}
