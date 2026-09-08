# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

The website uses Astro, React, and Tailwind CSS, explicitly requested by the owner. The CLI is TypeScript compiled with Bun.

## Users

Developers using Claude Code, Codex, Pi, or OpenCode who need to recover the context of earlier coding conversations.

## Product Purpose

Pacifico imports native local sessions into a durable archive and searchable index, then exposes bounded retrieval through MCP. The website helps someone understand that purpose, install the executable, and verify the integration.

## Capabilities and Constraints

Four source harnesses, SQLite FTS5 search, 5 MCP tools, no bundled skills or prompts, curated memory, reports, and an optional macOS daemon. Linux supports single-pass importing but not automatic service registration. Homebrew binaries include their runtime. No team synchronization or hosted account system is implemented. Search requires no model service. Pricing reports may access the network.

## Brand Commitments

Lowercase `pacifico` in a serif face, with Helvetica Neue for all other website text. English and Spanish versions. Readable installation snippets with working copy buttons. The landing starts with the name, a short explanation, and installation. The README must remain short and exclude engineering notes or documentation listings.

## Evidence on Hand

The shipped CLI, parsers, MCP schemas, public release workflow, and Homebrew tap. Source is a derivative of nicknisi/sessions under MIT. No testimonials, customer counts, download counts, or benchmark claims are established.

## Product Principles

Use exact supported commands. Keep durable data distinct from rebuildable indexes. Explain what setup changes. Preserve upstream attribution. State optional features as optional.

## Accessibility & Inclusion

English and Spanish must have equivalent information and functioning controls. Preserve keyboard access, visible focus, readable contrast, reduced-motion support, and narrow-screen usability.
