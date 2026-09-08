# Project scope

Pacifico started from `nicknisi/sessions` at commit `9f3c401896bb5b5620c07e07063cd235aab3d4a6` (version 1.29.2). Its Git history and MIT attribution are preserved. It does not contain Mosaic's proprietary source.

## Initial work

1. Clone and establish a baseline: 1,185 passing tests, 9 optional skips, and 3,607 assertions.
2. Map the inherited engine and the additional local features in [FEATURES.md](FEATURES.md).
3. Record the observable Mosaic installation and storage behavior in [MOSAIC.md](MOSAIC.md), distinguishing evidence from inference.
4. Identify the language, runtime, storage, protocol, and distribution in [TECHNOLOGY.md](TECHNOLOGY.md).
5. Compare language, module, and retention choices in [DECISIONS.md](DECISIONS.md).
6. Establish the monorepo boundaries described in [ARCHITECTURE.md](ARCHITECTURE.md).
7. Validate the compiled executable with isolated installation, MCP, retrieval, archive, and removal checks.

The design approach follows John Ousterhout's principles: hide implementation decisions, avoid forwarding-only layers, compare alternatives, and preserve useful deep modules. Moving files alone does not establish a performance improvement.

## Subsequent scope

The optional macOS daemon was added after the initial refactor. Public GitHub releases and the Homebrew tap use the personal `emersoftware` account. The website is now a dedicated bilingual Pacifico landing page, with Astro, React, and Tailwind CSS.

## Future work

Cross-machine synchronization, team permissions, and remote handoffs remain outside the local product. A Go or Rust port should be considered only if runtime size, startup, or memory measurements justify the cost. See [VALIDATION.md](VALIDATION.md) for the scope of verified behavior.
