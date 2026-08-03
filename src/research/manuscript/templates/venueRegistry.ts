import type { ManuscriptVenueId } from "../types.js";

/**
 * Venue template registry — the open, built-in catalog of publication venues.
 *
 * Design principles (per the platform architecture):
 * - **Generic**: one data shape covers conferences and journals; nothing in
 *   the registry hard-codes a pipeline stage.
 * - **Built-in**: a curated catalog of the venues a research platform is most
 *   likely to target ships with the product.
 * - **Open**: `archiveUrl`/`commit`/`archiveSha256` are *candidates*, not
 *   verdicts. Most built-in entries are deliberately unverified (verified:
 *   false) — the agent locates the official template via `officialPageUrl`,
 *   downloads it, and *proves* integrity with a probe before pinning. The
 *   choice of venue, year, and template source belongs to the agent, not to
 *   this catalog.
 * - **Extensible**: project-level `venues.json` entries (or programmatic
 *   registration) extend the catalog without code changes.
 */

export type VenueKind = "conference" | "journal";

export type VenueTemplateSource = Readonly<{
  /** Year this source is authoritative for (conference year / volume). */
  year?: number;
  /** Official page where the author kit / template can be located. */
  officialPageUrl: string;
  /** Direct archive URL candidate (may need verification). */
  archiveUrl?: string;
  /** Source repository (GitHub/Overleaf mirror) candidate. */
  repositoryUrl?: string;
  /** Commit / tag pinned by a prior verification (empty until verified). */
  commit?: string;
  archiveSha256?: string;
  archiveBytes?: number;
  /** Files a verified template must contain (sty/bst/main.tex …). */
  requiredFiles?: readonly string[];
  /** Whether this source has been integrity-verified by a probe. */
  verified: boolean;
  /** Free-form guidance for the agent (double-column? anonymous? pages?). */
  notes?: string;
}>;

export type VenueDefinition = Readonly<{
  id: ManuscriptVenueId;
  kind: VenueKind;
  displayName: string;
  publisher?: string;
  /** Template sources, most recent first; resolved with year fallback. */
  sources: readonly VenueTemplateSource[];
  /** Journal convention: page limit for the main text. */
  defaultPageLimit?: number;
  /** Conference convention: default anonymous submission. */
  anonymousSubmission?: boolean;
}>;

const VERIFIED_ICLR_2026 = Object.freeze<VenueTemplateSource>({
  year: 2026,
  officialPageUrl: "https://iclr.cc/Conferences/2026/AuthorGuide",
  archiveUrl: "https://raw.githubusercontent.com/ICLR/Master-Template/a28d335b0d46a3c39b205704a65faf41c9748433/iclr2026.zip",
  repositoryUrl: "https://github.com/ICLR/Master-Template",
  commit: "a28d335b0d46a3c39b205704a65faf41c9748433",
  archiveSha256: "sha256:b6d63b29992e153f804bb6d170c57db156c011b5bedf96a9f31d58813b909acf",
  archiveBytes: 241_296,
  requiredFiles: Object.freeze([
    "fancyhdr.sty",
    "iclr2026_conference.bst",
    "iclr2026_conference.sty",
    "math_commands.tex",
    "natbib.sty",
  ]),
  verified: true,
  notes: "Official ICLR Master-Template at the verified commit. Anonymous submission is the default mode.",
});

/**
 * Built-in venue catalog. Sources marked `verified: false` are candidates —
 * the agent must verify them (web fetch + template probe) before pinning.
 * URLs are the authoritative public entry points as of 2026-08.
 */
export const BUILTIN_VENUES: readonly VenueDefinition[] = Object.freeze([
  Object.freeze({
    id: "iclr",
    kind: "conference",
    displayName: "International Conference on Learning Representations",
    publisher: "ICLR",
    anonymousSubmission: true,
    defaultPageLimit: 9,
    sources: Object.freeze([
      VERIFIED_ICLR_2026,
      Object.freeze<VenueTemplateSource>({
        year: 2025,
        officialPageUrl: "https://iclr.cc/Conferences/2025/AuthorGuide",
        archiveUrl: "https://raw.githubusercontent.com/ICLR/Master-Template/1d19b83bce2c04a0490f38252a9de7b4e2062fdc/iclr2025.zip",
        repositoryUrl: "https://github.com/ICLR/Master-Template",
        verified: false,
        notes: "Prior-year ICLR template. If the target year has no official template yet, use the latest verified year and adjust the year token.",
      }),
      Object.freeze<VenueTemplateSource>({
        officialPageUrl: "https://iclr.cc",
        repositoryUrl: "https://github.com/ICLR/Master-Template",
        verified: false,
        notes: "Unverified-year fallback: agent should locate the newest official Master-Template commit and pin it after probing.",
      }),
    ]),
  }),
  Object.freeze({
    id: "icml",
    kind: "conference",
    displayName: "International Conference on Machine Learning",
    publisher: "PMLR",
    anonymousSubmission: true,
    defaultPageLimit: 9,
    sources: Object.freeze([
      Object.freeze<VenueTemplateSource>({
        year: 2025,
        officialPageUrl: "https://icml.cc/Conferences/2025/StyleAuthorInstructions",
        archiveUrl: "https://media.icml.cc/Conferences/ICML2025/Styles/icml2025.zip",
        verified: false,
        notes: "Official ICML style archive hosted on icml.cc media. Verify sha256 before pinning.",
      }),
      Object.freeze<VenueTemplateSource>({
        officialPageUrl: "https://icml.cc/Conferences/2024/StyleAuthorInstructions",
        archiveUrl: "https://media.icml.cc/Conferences/ICML2024/Styles/icml2024.zip",
        verified: false,
        notes: "Prior-year fallback.",
      }),
    ]),
  }),
  Object.freeze({
    id: "neurips",
    kind: "conference",
    displayName: "Conference on Neural Information Processing Systems",
    publisher: "NeurIPS",
    anonymousSubmission: true,
    defaultPageLimit: 9,
    sources: Object.freeze([
      Object.freeze<VenueTemplateSource>({
        year: 2025,
        officialPageUrl: "https://neurips.cc/Conferences/2025/CallForPapers",
        archiveUrl: "https://media.neurips.cc/Conferences/NeurIPS2025/Styles/neurips_2025.zip",
        repositoryUrl: "https://github.com/neurips-community/neurips-latex",
        verified: false,
        notes: "Official NeurIPS style; the community mirror (neurips-latex) is the maintained fork.",
      }),
      Object.freeze<VenueTemplateSource>({
        year: 2024,
        officialPageUrl: "https://neurips.cc/Conferences/2024/CallForPapers",
        archiveUrl: "https://media.neurips.cc/Conferences/NeurIPS2024/Styles/neurips_2024.zip",
        verified: false,
      }),
    ]),
  }),
  Object.freeze({
    id: "acl",
    kind: "conference",
    displayName: "Annual Meeting of the Association for Computational Linguistics",
    publisher: "ACL",
    anonymousSubmission: true,
    defaultPageLimit: 8,
    sources: Object.freeze([
      Object.freeze<VenueTemplateSource>({
        officialPageUrl: "https://github.com/acl-org/acl-style-files",
        repositoryUrl: "https://github.com/acl-org/acl-style-files",
        requiredFiles: Object.freeze(["acl.sty", "acl_natbib.bst"]),
        verified: false,
        notes: "Official ACL style files (shared by ACL/EMNLP/NAACL/COLING). Uses acl.sty + acl_natbib.bst; conference year is adjusted in the author block.",
      }),
    ]),
  }),
  Object.freeze({
    id: "emnlp",
    kind: "conference",
    displayName: "Conference on Empirical Methods in Natural Language Processing",
    publisher: "ACL",
    anonymousSubmission: true,
    defaultPageLimit: 8,
    sources: Object.freeze([
      Object.freeze<VenueTemplateSource>({
        officialPageUrl: "https://github.com/acl-org/acl-style-files",
        repositoryUrl: "https://github.com/acl-org/acl-style-files",
        verified: false,
        notes: "Same official ACL style files as ACL.",
      }),
    ]),
  }),
  Object.freeze({
    id: "naacl",
    kind: "conference",
    displayName: "North American Chapter of the ACL",
    publisher: "ACL",
    anonymousSubmission: true,
    defaultPageLimit: 8,
    sources: Object.freeze([
      Object.freeze<VenueTemplateSource>({
        officialPageUrl: "https://github.com/acl-org/acl-style-files",
        repositoryUrl: "https://github.com/acl-org/acl-style-files",
        verified: false,
      }),
    ]),
  }),
  Object.freeze({
    id: "cvpr",
    kind: "conference",
    displayName: "IEEE/CVF Conference on Computer Vision and Pattern Recognition",
    publisher: "IEEE/CVF",
    anonymousSubmission: true,
    defaultPageLimit: 8,
    sources: Object.freeze([
      Object.freeze<VenueTemplateSource>({
        year: 2025,
        officialPageUrl: "https://cvpr.thecvf.com/Conferences/2025/AuthorGuidelines",
        archiveUrl: "https://cvpr.thecvf.com/media/icvf_zip/CVPR2025/cvpr2025-author-kit.zip",
        verified: false,
        notes: "CVPR author kit (IEEEtran-based, cvpr.sty). Verify the exact zip URL on the author guidelines page.",
      }),
    ]),
  }),
  Object.freeze({
    id: "iccv",
    kind: "conference",
    displayName: "International Conference on Computer Vision",
    publisher: "IEEE/CVF",
    anonymousSubmission: true,
    defaultPageLimit: 8,
    sources: Object.freeze([
      Object.freeze<VenueTemplateSource>({
        officialPageUrl: "https://iccv.thecvf.com/Conferences/2025/AuthorGuidelines",
        verified: false,
        notes: "ICCV author kit mirrors CVPR's (cvpr.sty with venue-adjusted macros).",
      }),
    ]),
  }),
  Object.freeze({
    id: "aaai",
    kind: "conference",
    displayName: "AAAI Conference on Artificial Intelligence",
    publisher: "AAAI",
    anonymousSubmission: true,
    defaultPageLimit: 7,
    sources: Object.freeze([
      Object.freeze<VenueTemplateSource>({
        year: 2025,
        officialPageUrl: "https://aaai.org/conference/aaai-25-submission-site/",
        verified: false,
        notes: "AAAI author kit (aaai25.sty). Locate the official kit zip on the submission site.",
      }),
    ]),
  }),
  Object.freeze({
    id: "colm",
    kind: "conference",
    displayName: "Conference on Language Modeling",
    publisher: "COLM",
    anonymousSubmission: true,
    defaultPageLimit: 9,
    sources: Object.freeze([
      Object.freeze<VenueTemplateSource>({
        year: 2024,
        officialPageUrl: "https://colmweb.org/index.html",
        verified: false,
        notes: "COLM template (colm.sty). Locate via the official site; check the current year's instructions.",
      }),
    ]),
  }),
  Object.freeze({
    id: "jmlr",
    kind: "journal",
    displayName: "Journal of Machine Learning Research",
    publisher: "MIT Press / JMLR",
    anonymousSubmission: false,
    defaultPageLimit: undefined,
    sources: Object.freeze([
      Object.freeze<VenueTemplateSource>({
        officialPageUrl: "https://www.jmlr.org/format/format.html",
        archiveUrl: "https://mirrors.ctan.org/macros/latex/contrib/jmlr2e.zip",
        repositoryUrl: "https://ctan.org/pkg/jmlr2e",
        requiredFiles: Object.freeze(["jmlr2e.sty", "jmlr2e.cls", "jmlr2e.bst"]),
        verified: false,
        notes: "jmlr2e on CTAN is the canonical journal class. Camera-ready; no anonymity.",
      }),
    ]),
  }),
  Object.freeze({
    id: "tmlr",
    kind: "journal",
    displayName: "Transactions on Machine Learning Research",
    publisher: "TMLR",
    anonymousSubmission: false,
    defaultPageLimit: undefined,
    sources: Object.freeze([
      Object.freeze<VenueTemplateSource>({
        officialPageUrl: "https://jmlr.org/tmlr/author-guide.html",
        repositoryUrl: "https://github.com/JmlrOrg/tmlr-style",
        archiveUrl: "https://github.com/JmlrOrg/tmlr-style/archive/refs/heads/main.zip",
        requiredFiles: Object.freeze(["tmlr.sty"]),
        verified: false,
        notes: "Official tmlr-style GitHub repository.",
      }),
    ]),
  }),
  Object.freeze({
    id: "tpami",
    kind: "journal",
    displayName: "IEEE Transactions on Pattern Analysis and Machine Intelligence",
    publisher: "IEEE",
    anonymousSubmission: false,
    defaultPageLimit: 14,
    sources: Object.freeze([
      Object.freeze<VenueTemplateSource>({
        officialPageUrl: "https://journals.ieeeauthorcenter.ieee.org/create-your-ieee-journal-article/authoring-tools-and-templates/",
        archiveUrl: "https://mirrors.ctan.org/macros/latex/contrib/IEEEtran.zip",
        repositoryUrl: "https://ctan.org/pkg/ieeetran",
        requiredFiles: Object.freeze(["IEEEtran.cls", "IEEEtran.bst"]),
        verified: false,
        notes: "IEEEtran class from CTAN; journal-specific formatting via IEEEtran options. Camera-ready.",
      }),
    ]),
  }),
  Object.freeze({
    id: "ieeetrans",
    kind: "journal",
    displayName: "IEEE Transactions (generic)",
    publisher: "IEEE",
    anonymousSubmission: false,
    defaultPageLimit: undefined,
    sources: Object.freeze([
      Object.freeze<VenueTemplateSource>({
        officialPageUrl: "https://journals.ieeeauthorcenter.ieee.org/create-your-ieee-journal-article/authoring-tools-and-templates/",
        archiveUrl: "https://mirrors.ctan.org/macros/latex/contrib/IEEEtran.zip",
        repositoryUrl: "https://ctan.org/pkg/ieeetran",
        verified: false,
        notes: "Generic IEEE Transactions template (IEEEtran).",
      }),
    ]),
  }),
  Object.freeze({
    id: "neural_computation",
    kind: "journal",
    displayName: "Neural Computation",
    publisher: "MIT Press",
    anonymousSubmission: false,
    defaultPageLimit: undefined,
    sources: Object.freeze([
      Object.freeze<VenueTemplateSource>({
        officialPageUrl: "https://direct.mit.edu/neco/pages/submissionguidelines",
        verified: false,
        notes: "MIT Press journal; LaTeX template is distributed via the submission portal (ScholarOne).",
      }),
    ]),
  }),
  Object.freeze({
    id: "nature_mi",
    kind: "journal",
    displayName: "Nature Machine Intelligence",
    publisher: "Springer Nature",
    anonymousSubmission: false,
    defaultPageLimit: undefined,
    sources: Object.freeze([
      Object.freeze<VenueTemplateSource>({
        officialPageUrl: "https://www.nature.com/natmachintell/submit-guide",
        verified: false,
        notes: "Springer Nature template (sn-article template on Overleaf/Snapp). Agent should fetch the current sn-article class.",
      }),
    ]),
  }),
  Object.freeze({
    id: "science_advances",
    kind: "journal",
    displayName: "Science Advances",
    publisher: "AAAS",
    anonymousSubmission: false,
    defaultPageLimit: undefined,
    sources: Object.freeze([
      Object.freeze<VenueTemplateSource>({
        officialPageUrl: "https://www.science.org/content/page/science-advances-general-information-authors",
        verified: false,
        notes: "AAAS manuscript template; the LaTeX class is distributed via the submission system.",
      }),
    ]),
  }),
  Object.freeze({
    id: "pnas",
    kind: "journal",
    displayName: "Proceedings of the National Academy of Sciences",
    publisher: "PNAS",
    anonymousSubmission: false,
    defaultPageLimit: 6,
    sources: Object.freeze([
      Object.freeze<VenueTemplateSource>({
        officialPageUrl: "https://www.pnas.org/author-center/latex",
        verified: false,
        notes: "PNAS author kit (pnasnew.cls + pnasmark). Six-page main text convention.",
      }),
    ]),
  }),
]);

export const BUILTIN_VENUE_IDS: readonly ManuscriptVenueId[] = Object.freeze(
  BUILTIN_VENUES.map((venue) => venue.id),
);
