/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  RESEARCH_PANEL_ACTIVATE_EVENT,
  isResearchPanelActivation,
  type ResearchPanelActivation,
} from '../research/activation';
import { isResearchPanelEntry, type ResearchPanelEntry } from '../research/types';

const RESEARCH_AUTO_OPEN_ON_INTENT_STORAGE_KEY = 'rigorium.research.auto-open-on-intent';

type ResearchPanelState = {
  artifact: ResearchPanelEntry | null;
  artifactProjectPath: string | null;
  activation: ResearchPanelActivation | null;
  activationProjectPath: string | null;
  isOpen: boolean;
  isExpanded: boolean;
  selectedPaperId: string | null;
};

type ResearchPanelContextValue = ResearchPanelState & {
  autoOpenOnIntent: boolean;
  ingestArtifact: (artifact: ResearchPanelEntry, projectPath?: string | null) => void;
  activatePanel: (activation: ResearchPanelActivation, projectPath?: string | null) => void;
  openPanel: () => void;
  closePanel: () => void;
  setExpanded: (expanded: boolean) => void;
  setAutoOpenOnIntent: (enabled: boolean) => void;
  selectPaper: (paperId: string) => void;
};

const FALLBACK_RESEARCH_PANEL: ResearchPanelContextValue = {
  artifact: null,
  artifactProjectPath: null,
  activation: null,
  activationProjectPath: null,
  isOpen: false,
  isExpanded: false,
  selectedPaperId: null,
  autoOpenOnIntent: true,
  ingestArtifact: () => undefined,
  activatePanel: () => undefined,
  openPanel: () => undefined,
  closePanel: () => undefined,
  setExpanded: () => undefined,
  setAutoOpenOnIntent: () => undefined,
  selectPaper: () => undefined,
};

const ResearchPanelContext = createContext<ResearchPanelContextValue>(FALLBACK_RESEARCH_PANEL);

export function ResearchPanelProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ResearchPanelState>({
    artifact: null,
    artifactProjectPath: null,
    activation: null,
    activationProjectPath: null,
    isOpen: false,
    isExpanded: false,
    selectedPaperId: null,
  });
  const [autoOpenOnIntent, setAutoOpenOnIntentState] = useState(readAutoOpenOnIntent);

  const ingestArtifact = useCallback((artifact: ResearchPanelEntry, projectPath?: string | null) => {
    setState((current) => {
      if (current.artifact?.artifactId === artifact.artifactId) return current;
      const isLiteratureArtifact = artifact.kind === 'literature_search' || artifact.kind === 'literature_expansion';
      const autoOpen = artifact.kind === 'research_tool_activity' || artifact.presentation?.autoOpen !== false;
      return {
        artifact,
        artifactProjectPath: projectPath || null,
        activation: null,
        activationProjectPath: null,
        isOpen: autoOpen,
        isExpanded: false,
        selectedPaperId: isLiteratureArtifact
          ? artifact.papers[0]?.id ?? null
          : null,
      };
    });
  }, []);

  const activatePanel = useCallback((activation: ResearchPanelActivation, projectPath?: string | null) => {
    if (!autoOpenOnIntent) return;
    setState({
      artifact: null,
      artifactProjectPath: null,
      activation,
      activationProjectPath: projectPath || null,
      isOpen: true,
      isExpanded: false,
      selectedPaperId: null,
    });
  }, [autoOpenOnIntent]);

  const setAutoOpenOnIntent = useCallback((enabled: boolean) => {
    setAutoOpenOnIntentState(enabled);
    try {
      window.localStorage.setItem(RESEARCH_AUTO_OPEN_ON_INTENT_STORAGE_KEY, enabled ? 'true' : 'false');
    } catch {
      // The preference remains available for the active desktop session.
    }
  }, []);

  useEffect(() => {
    const handleArtifact = (event: Event) => {
      const detail = (event as CustomEvent<{ artifact?: unknown; projectPath?: unknown }>).detail;
      if (!isResearchPanelEntry(detail?.artifact)) return;
      ingestArtifact(
        detail.artifact,
        typeof detail.projectPath === 'string' ? detail.projectPath : null,
      );
    };
    window.addEventListener('rigorium:research-artifact', handleArtifact);
    return () => window.removeEventListener('rigorium:research-artifact', handleArtifact);
  }, [ingestArtifact]);

  useEffect(() => {
    const handleActivation = (event: Event) => {
      const detail = (event as CustomEvent<{ activation?: unknown; projectPath?: unknown }>).detail;
      if (!isResearchPanelActivation(detail?.activation)) return;
      activatePanel(
        detail.activation,
        typeof detail.projectPath === 'string' ? detail.projectPath : null,
      );
    };
    window.addEventListener(RESEARCH_PANEL_ACTIVATE_EVENT, handleActivation);
    return () => window.removeEventListener(RESEARCH_PANEL_ACTIVATE_EVENT, handleActivation);
  }, [activatePanel]);

  const value = useMemo<ResearchPanelContextValue>(() => ({
    ...state,
    autoOpenOnIntent,
    ingestArtifact,
    activatePanel,
    openPanel: () => setState((current) => ({ ...current, isOpen: true })),
    closePanel: () => setState((current) => ({ ...current, isOpen: false, isExpanded: false })),
    setExpanded: (isExpanded) => setState((current) => ({ ...current, isExpanded })),
    setAutoOpenOnIntent,
    selectPaper: (selectedPaperId) => setState((current) => ({ ...current, selectedPaperId })),
  }), [activatePanel, autoOpenOnIntent, ingestArtifact, setAutoOpenOnIntent, state]);

  return <ResearchPanelContext.Provider value={value}>{children}</ResearchPanelContext.Provider>;
}

export function useResearchPanel(): ResearchPanelContextValue {
  return useContext(ResearchPanelContext);
}

function readAutoOpenOnIntent(): boolean {
  try {
    return window.localStorage.getItem(RESEARCH_AUTO_OPEN_ON_INTENT_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}
