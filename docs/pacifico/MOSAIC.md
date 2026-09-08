# Mosaic: observed behavior

Research snapshot: September 5, 2026. This document records observations from that date, not a claim about Mosaic's current implementation. Its backend source was not accessed.

## Installation

The public installation guide described browser authorization, team selection, source discovery, registration of `com.ocean.daemon`, preparation of a local replica, and agent skills. It stated that it did not install hooks or MCP servers. The visible replica was `~/.mosaic`, with application state under Application Support/Ocean and service registration under LaunchAgents. Synchronization ran while the user was logged in.

The inspected Homebrew formula (0.2.24) distributed `ocean`, `orgtrace`, `rclone`, and `Ocean.app`, with a `mosaic` alias. It also handled optional `node` and `ocean.mjs` artifacts. Installation used precompiled artifacts rather than necessarily compiling source locally.

On the inspected Mac, `mosaic` and `orgtrace` pointed to `ocean`. The ARM64 Mach-O executable was approximately 145 MB; rclone was approximately 82 MB. Binary strings included bundled JavaScript and Ink. That establishes distributed JavaScript, not that the native app or backend uses TypeScript.

## Replica organization

The installed skill documented this structure:

```text
~/.mosaic/
  SessionIndex/<owner>/<agent>/<project>/<session-id>.json
  People/<owner>/<agent>/<provider-native-relative-path>
```

The catalog carried metadata and content references; one session could contain multiple objects. Queries began with metadata, then opened selected native artifacts. Remote storage was described as authoritative and the local tree as a read-only replica subject to hydration and eviction. Private People content was not inspected.

The evidence was consistent with native sources flowing through local collection into shared remote storage, then into a local replica/catalog consumed through the CLI or skills. This is an inference, not a reproduction of proprietary implementation details. The presence of rclone alone does not identify the cloud provider or storage schema.

## Unknowns

Backend language and database, exact transport, reconciliation rules, encryption implementation, object-level authorization, deduplication, truncation handling, and universal native-fork behavior were not established. No public price or billing unit was verified for the reported US$99 offer.

## Relevance to Pacifico

Personal recall can use local archival and search without a shared backend. Collaboration introduces additional identity, permissions, consistency, and operational requirements. Pacifico does not claim to reproduce Mosaic completely and does not depend on its bundled code or services.

Reference: [Mosaic installation guide](https://mosaic.inc/install). Public pages may change after this research snapshot.
