---
name: venue-template
description: Pick a publication venue, resolve and verify its official template, and pin it for the project before any writing starts — the target venue is decided up front, not after the paper exists.
---

# Choose a Venue and Pin Its Template

The venue decision happens **before** research writing begins. You decide — this
skill gives you the tools and the decision criteria, never a fixed workflow.

## When to use

- The user mentions a target venue ("我想投 ICLR", "targeting TMLR"), or
- a research direction is starting and no venue is pinned yet.

## Decision procedure (you choose; nothing is automatic)

1. **Survey the catalog**: `venue_template action=list` — see conferences
   (ICLR, ICML, NeurIPS, ACL, EMNLP, NAACL, CVPR, ICCV, AAAI, COLM) and
   journals (JMLR, TMLR, TPAMI, IEEE Transactions, Neural Computation, Nature
   Machine Intelligence, Science Advances, PNAS) plus any project-custom
   venues. Match the research type to the venue: empirical ML → ICLR/ICML/
   NeurIPS; language → ACL/EMNLP; vision → CVPR/ICCV; a mature contribution →
   a journal.
2. **Resolve templates**: `venue_template action=resolve venue=<id> year=<year>`
   — the resolver ranks exact-year sources first, then evergreen sources, then
   prior years with an explicit `yearAdjusted` flag. If the target year has no
   official template yet (e.g. ICLR 2027 before the official release), the
   resolver tells you the closest prior verified year.
3. **Fallback policy (year adjustment)**: if the official template for the
   target year is not available, take the closest prior-year official
   template and adjust the year tokens in the style/class macros
   (e.g. `iclr2026` → `iclr2027` where the venue publishes a new year's
   style; keep the class name when the venue does not year-version its
   style, as with ACL's `acl.sty`). State the adjustment explicitly in your
   plan and in the pinned source notes.
4. **Verify before pinning**: download the archive, compute its SHA-256,
   confirm the required files, and probe the extracted directory with
   `manuscript_latex action=template_probe` (or the venue's own checks).
   A pin records `verified: true` — never pin an unverified download.
5. **Pin**: `venue_template action=pin venue=<id> year=<year> source={...}`
   with the official page URL, archive URL, sha256, and required files. The
   pin is stored in the project registry (`<project>/.rigorium/research/
   venues/venues.json`) and later renders prefer verified pins.
6. **Learn the venue's writing style**: after pinning, download ~10
   high-quality papers from that venue (recent Best Papers + high-scoring
   papers) and study them at fine granularity — sentence templates,
   paragraph structure, figure style, story arc — before drafting. The
   style profile guides every subsequent writing step for this paper.

## Hard rules

- The venue/template choice is **yours and the user's** — if the user has no
  preference, recommend one with a one-line rationale, but never silently
  assume.
- Never pin a source you have not integrity-verified.
- A year-adjusted template must be noted as adjusted in the pin's `notes`.
- Journal targets: check `defaultPageLimit` and anonymity conventions from
  the `list` output — journals are camera-ready, conferences are usually
  anonymous submissions.
