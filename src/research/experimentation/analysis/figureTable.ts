import type {
  ResearchArtifactProducer,
  ResearchArtifactRef,
} from "../../artifacts/index.js";
import {
  createFigureTableArtifact,
  type FigureTableArtifact,
} from "../../manuscript/index.js";
import type { AnalysisFigureTableInput } from "./contracts.js";

export function createAnalysisFigureTableArtifact(input: {
  figureTable?: AnalysisFigureTableInput;
  provenanceRunRefs: readonly ResearchArtifactRef[];
  producer: ResearchArtifactProducer;
  now: Date;
}): FigureTableArtifact | undefined {
  if (!input.figureTable) return undefined;
  return createFigureTableArtifact({
    items: input.figureTable.items,
    provenanceRefs: input.provenanceRunRefs,
    producer: input.producer,
    ...(input.figureTable.artifactId === undefined ? {} : { artifactId: input.figureTable.artifactId }),
    now: input.now,
  });
}
