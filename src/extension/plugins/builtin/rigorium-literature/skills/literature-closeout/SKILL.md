---
description: Build traceable literature evidence, rescan candidate directions across official sources, monitor candidate-only updates, and operate reviewed literature maps.
---

Use the existing Rigorium literature adapters and project repositories.

- Search OpenAlex, Crossref, arXiv, and OpenReview through their existing adapters. Preserve provider status, query URLs, identifiers, and coverage limitations.
- Call `literature_closeout` with `action=evidence_pack` to build evidence packs with an original page, paragraph, section, or character locator. Keep the exact source snapshot and verify its SHA-256 hash before reuse.
- Call `literature_closeout` with `action=novelty_rescan` to rescan candidate directions across more than one configured source when possible. Treat novelty and value as auditable signals, never as a one-source fact.
- Call `literature_closeout` with `action=candidate_monitor_poll` to poll Zotero and preprint providers into the project-local candidate ledger only. Do not promote candidates into a reviewed map or formal library without the existing user action.
- When the user asks in natural language to keep watching, track periodically, or check for new work on a schedule, use the existing `cron_create` tool to persist that schedule. Its message must call `literature_closeout` with `action=candidate_monitor_poll` and preserve the requested query, sources, date bounds, and Zotero collection. Use `cron_list`, `cron_stop`, and `cron_delete` for status and lifecycle changes. A scheduled monitor remains candidate-only and must never write to Zotero, create a reviewed-map snapshot, export, or confirm a title.
- Use the existing bridge analysis, immutable snapshot, diff, tombstone, and restore operations. Snapshot creation and destructive lifecycle actions require explicit UI actions.
