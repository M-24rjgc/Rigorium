# Venue pin — ICLR 2026

Decision record (made at project start, per PaperStudio protocol):

- **Venue**: ICLR (International Conference on Learning Representations),
  conference, anonymous submission, 9-page limit.
- **Year**: 2026 — the official ICLR 2026 author kit exists and is
  integrity-verified in the built-in registry (commit
  `a28d335b0d46a3c39b205704a65faf41c9748433`, sha256 pinned). If the target
  year moves to 2027 before the kit ships, use the 2026 kit and adjust the
  year token (the registry's documented fallback policy).
- **Machine-readable**: written as a project-level venue override at
  `.rigorium/research/venues/venues.json`, so the venue-template tool and
  the orchestrator resolve exactly the pinned source without code changes.
- **Style learning**: before writing, download ~10 high-scoring ICLR 2024–2025
  papers into the venue corpus and learn the style profile (sentence/paragraph
  templates, story line, figure conventions) into the project memory.
