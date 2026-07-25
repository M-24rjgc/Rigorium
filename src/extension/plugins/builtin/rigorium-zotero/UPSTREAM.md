# Upstream and service boundary

Audited: 2026-07-25

This plugin interoperates with Zotero through documented HTTP interfaces. It does not vendor or modify Zotero client source.

| Upstream | What is used | License or service boundary | Runtime choice |
| --- | --- | --- | --- |
| [Zotero Web API v3](https://www.zotero.org/support/dev/web_api/v3/basics) | Authorized library reads, exports, tag changes, and note changes | Non-public libraries require an API key with appropriate privileges. Clients must honor `Backoff` and `Retry-After`; write access does not grant new rights to item metadata, attachments, or linked publications. | Rigorium reuses its existing server-side authorized transport, requests API version 3, keeps keys out of plugin settings/artifacts, and reports provider backoff. |
| [Zotero write requests](https://www.zotero.org/support/dev/web_api/v3/write_requests) | Version-checked item and library updates | Zotero documents object/library version preconditions and rejects stale updates. | The provider builds a previewable write plan, requires `confirmed: true`, sends `If-Unmodified-Since-Version`, and surfaces conflicts instead of silently overwriting. |
| [Zotero Local API](https://www.zotero.org/support/dev/web_api/v3/basics#local-api) | Status, collections, items, tags, attachment text, files, and official exports from the desktop app | Availability depends on the user's Zotero desktop preference and local process. | The provider accepts only loopback endpoints and is read-only by default. Candidate monitoring calls list/read methods only and never promotes records into the formal library or literature map. |
| [Zotero Connector HTTP server](https://www.zotero.org/support/dev/client_coding/connector_http_server) | Existing `/connector/saveItems` import path | Import changes the user's library and is therefore a write even though it uses a local endpoint. | The existing provider requires explicit confirmation before invoking the connector path. |

Zotero desktop source is distributed under [GNU AGPL v3](https://github.com/zotero/zotero/blob/main/COPYING), and the Zotero name is a registered trademark. No Zotero source is copied, linked, or modified by this plugin; interoperability is through the documented APIs. A separate Zotero SDK was deliberately not added because the existing TypeScript providers already implement the required versioning, confirmation, rate-limit, and offline behavior without another runtime or credential path.
