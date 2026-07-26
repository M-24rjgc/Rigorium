# Research Artifact repository storage decision

Verified on 2026-07-25. This record concerns the Project-local Artifact repository only.

## Candidate probes

| Candidate | Local result | Decision |
| --- | --- | --- |
| Existing `better-sqlite3` dependency | The installed native module was compiled for `NODE_MODULE_VERSION 136`; the active Node `v23.10.0` requires `131`. Opening a probe database failed with `ERR_DLOPEN_FAILED`. Installing or rebuilding was outside the approved boundary. | Not used in this increment. Re-evaluate under the supported Node 22 runtime with a matching native build before migration. |
| Existing atomic JSON pattern | A unique temporary-directory probe completed file creation, file `fsync`, atomic `rename`, and reopen with identical parsed content. Mature project-local implementations already use the same lock and atomic-replace pattern. | Adopted with a bounded, integrity-hashed manifest, append-only envelopes and status events, and a short-lived exclusive lock. |
| DVC | `dvc` was not present on `PATH`. | Excluded from the runtime path. DVC would also manage file/data versions rather than replace the Artifact envelope and dependency contract. |

## Persistence boundary

Each Project owns `.rigorium/research/artifacts/manifest.json`. Artifact envelopes are append-only. Status changes are append-only events, so superseding or invalidating an Artifact never erases its original payload, producer, sources, parents, timestamps, or content hash.

Writes validate the complete parent graph and canonical hashes under a short-lived lock, write a randomized same-directory temporary file, synchronize it, and atomically replace the manifest. A restart always reopens and verifies the committed manifest; leftover uncommitted temporary files are ignored. Status-event IDs are derived from their canonical event bodies; replay also requires chronological events, adjacent same-Artifact replacements, and status-event or embedded-invalidation targets that are strict descendants of every declared root. Newly appended descendants of a non-active ancestor are immediately materialized as stale through the same append-only event log. Corrupt JSON, manifest-hash drift, Artifact-hash drift, missing parents, revision gaps, invalid event identities, and event replay inconsistencies fail closed.

The JSON manifest is intentionally bounded at 64 MiB. A future SQLite migration should preserve this exact repository contract and run only after the native module is healthy under Rigorium's supported Node runtime.
