/**
 * Fine-grained venue style profile (Phase 3.2).
 *
 * The style profile is the *learned* answer to "how do papers at this venue
 * actually read?" — captured at sentence, paragraph, figure, and story level
 * from ~10 high-quality venue papers. It is produced by the agent (reading
 * the corpus with vision/text tools), validated structurally by the store,
 * and consumed by every later writing step for this paper.
 *
 * Deliberately open: fields are structured suggestions, not a fixed writing
 * checklist — the agent fills what the venue actually exhibits and leaves
 * the rest unset.
 */

export type StoryArcBeat = Readonly<{
  /** Section/phase, e.g. "intro-motivation", "method-notation". */
  phase: string;
  /** What this beat does (1-2 sentences). */
  function: string;
  /** How the venue papers typically open/close this beat. */
  convention: string;
  /** Typical length in the corpus. */
  typicalParagraphs?: number;
}>;

export type SentenceTemplate = Readonly<{
  /** Slot name, e.g. "claim-opener", "transition-gap", "limitation". */
  slot: string;
  /** The template with <placeholder> slots. */
  template: string;
  /** Where it typically appears. */
  position: string;
  /** 1-3 verbatim examples from the corpus (with paper id). */
  examples: readonly string[];
}>;

export type ParagraphPattern = Readonly<{
  /** Pattern name, e.g. "claim-evidence-explanation", "related-work-compare". */
  name: string;
  /** Sentence-level structure of the paragraph. */
  structure: readonly string[];
  /** How the last sentence hands off to the next paragraph. */
  transition: string;
}>;

export type FigureConvention = Readonly<{
  /** Figure type: architecture | data | qualitative | comparison. */
  figureType: string;
  /** Palette / style observed in the corpus (colors, fonts, grid). */
  styleNotes: string;
  /** Caption structure convention. */
  captionPattern: string;
  /** Rendering approach (LaTeX tikz, matplotlib, vector vs raster). */
  renderingApproach: string;
}>;

export type LaTeXConvention = Readonly<{
  /** Package/class conventions observed. */
  packages: readonly string[];
  /** Notation conventions (e.g. bold vectors, calligraphic sets). */
  notation: string;
  /** Theorem/definition environment usage. */
  environments: string;
  /** Citation density and placement. */
  citationStyle: string;
}>;

export type StyleProfile = Readonly<{
  venue: string;
  /** Year of the corpus the profile was learned from. */
  corpusYear?: number;
  /** Venue kind the profile targets (conference | journal). */
  venueKind?: "conference" | "journal";
  computedAt: string;
  /** Global voice notes: register, hedging, formality. */
  writingVoice?: string;
  /** Papers the profile was learned from (paperIds). */
  learnedFrom: readonly string[];
  /** Typical section order and length distribution. */
  storyArc: readonly StoryArcBeat[];
  sentenceTemplates: readonly SentenceTemplate[];
  paragraphPatterns: readonly ParagraphPattern[];
  figureConventions: readonly FigureConvention[];
  /** One consolidated LaTeX/notation convention set for the venue. */
  latexConventions?: LaTeXConvention;
  /** Free-form notes for the current paper. */
  notes?: string;
}>;
