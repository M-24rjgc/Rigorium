/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isResearchArtifact, type ResearchArtifact } from '../research/types';

type ResearchPanelState = {
  artifact: ResearchArtifact | null;
  artifactProjectPath: string | null;
  isOpen: boolean;
  isExpanded: boolean;
  selectedPaperId: string | null;
};

type ResearchPanelContextValue = ResearchPanelState & {
  ingestArtifact: (artifact: ResearchArtifact, projectPath?: string | null) => void;
  openPanel: () => void;
  closePanel: () => void;
  setExpanded: (expanded: boolean) => void;
  selectPaper: (paperId: string) => void;
};

const FALLBACK_RESEARCH_PANEL: ResearchPanelContextValue = {
  artifact: null,
  artifactProjectPath: null,
  isOpen: false,
  isExpanded: false,
  selectedPaperId: null,
  ingestArtifact: () => undefined,
  openPanel: () => undefined,
  closePanel: () => undefined,
  setExpanded: () => undefined,
  selectPaper: () => undefined,
};

const ResearchPanelContext = createContext<ResearchPanelContextValue>(FALLBACK_RESEARCH_PANEL);

export function ResearchPanelProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ResearchPanelState>({
    artifact: null,
    artifactProjectPath: null,
    isOpen: false,
    isExpanded: false,
    selectedPaperId: null,
  });

  const ingestArtifact = useCallback((artifact: ResearchArtifact, projectPath?: string | null) => {
    setState((current) => {
      if (current.artifact?.artifactId === artifact.artifactId) return current;
      return {
        artifact,
        artifactProjectPath: projectPath || null,
        isOpen: artifact.presentation?.autoOpen !== false,
        isExpanded: false,
        selectedPaperId: artifact.papers[0]?.id ?? null,
      };
    });
  }, []);

  useEffect(() => {
    const handleArtifact = (event: Event) => {
      const detail = (event as CustomEvent<{ artifact?: unknown; projectPath?: unknown }>).detail;
      if (!isResearchArtifact(detail?.artifact)) return;
      ingestArtifact(
        detail.artifact,
        typeof detail.projectPath === 'string' ? detail.projectPath : null,
      );
    };
    window.addEventListener('rigorium:research-artifact', handleArtifact);
    return () => window.removeEventListener('rigorium:research-artifact', handleArtifact);
  }, [ingestArtifact]);

  const value = useMemo<ResearchPanelContextValue>(() => ({
    ...state,
    ingestArtifact,
    openPanel: () => setState((current) => ({ ...current, isOpen: true })),
    closePanel: () => setState((current) => ({ ...current, isOpen: false, isExpanded: false })),
    setExpanded: (isExpanded) => setState((current) => ({ ...current, isExpanded })),
    selectPaper: (selectedPaperId) => setState((current) => ({ ...current, selectedPaperId })),
  }), [ingestArtifact, state]);

  return <ResearchPanelContext.Provider value={value}>{children}</ResearchPanelContext.Provider>;
}

export function useResearchPanel(): ResearchPanelContextValue {
  return useContext(ResearchPanelContext);
}
