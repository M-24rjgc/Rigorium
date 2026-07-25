---
name: manuscript-latex
description: Build, audit, version, and render evidence-aware LaTeX manuscripts from Rigorium research artifacts without inventing claims or results.
---

# Work With LaTeX Manuscripts

Use `manuscript_latex` for the operation the user currently needs. Do not force a fixed sequence.

- Create `action=citation_set` from structured Zotero items or structured BibTeX entry data. Preserve stable citation keys, source identity, and content hashes.
- Use `action=section_audit` before drafting evidence-bearing prose. Keep blocked result statements outline-only until an observed or replicated artifact is linked.
- Use `action=related_work` to organize reviewed map groups, citations, and exact EvidencePack locators. The returned plan is organization and coverage, not generated prior-work claims.
- Use `action=figure_table` only when data, script or a documented not-applicable reason, output, caption, and hashes are present. The tool verifies current Project files before accepting the artifact.
- Use `action=manuscript_version` to retain one canonical `main.tex` source. Derived PDFs and logs never replace that source.
- Use `action=template_probe` before venue rendering. ICLR 2026 has a verified official pin; ICLR 2027 is unverified until an official source is reviewed and pinned.
- Use `action=render` for deterministic compile diagnostics and separate compile, anonymity, page, citation, appendix, and template checks. A successful compiler exit does not erase warnings.
- Treat render staging as a controlled build boundary, not an operating-system sandbox. The tool sanitizes compiler environment variables and disables shell escape or enables the engine's verified untrusted mode.
- Export only when the user selected the destination and the request carries `confirmed: true`. Use `overwrite: true` only after explicit approval for replacement.
