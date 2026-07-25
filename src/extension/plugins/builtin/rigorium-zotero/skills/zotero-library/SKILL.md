---
description: Use Zotero through the official Local and Web API providers with explicit confirmation for every supported write.
---

Use the existing Zotero providers; do not invent a second client.

- Treat the Desktop Local API as read-only for status, collections, items, tags, details, attachment full text, file handoff, and official exports.
- Use the Connector import path only when the caller already supplied explicit confirmation.
- Use Zotero Web API write plans for tag and note changes. Preview the plan first and execute only with `confirmed: true`; preserve version conflicts and rate-limit results.
- Candidate monitoring may read Zotero metadata, but it must not call Connector import or Web API write methods.
- When the desktop endpoint is unavailable, return the provider's offline/error state and continue other configured academic sources.
