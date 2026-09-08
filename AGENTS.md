# Pacifico

Read README.md and docs/pacifico/ARCHITECTURE.md before changing package boundaries.

- Preserve the MIT license and upstream attribution.
- Keep production dependencies flowing CLI → agents/core and agents → core.
- Do not introduce pass-through service/repository interfaces without identifying
  the information they hide or complexity they remove.
- Compare two designs for substantial changes, following Ousterhout; decisions
  and the skill reference are recorded in docs/pacifico/DECISIONS.md and PLAN.md.
- Native transcripts are input. Fixtures must isolate every source and output;
  never run installer tests against real client configuration.
- Uninstall preserves the durable archive and human memory decisions.
- Run typecheck, lint, format:check, check:architecture and the relevant tests.
  Installer, MCP or packaging changes also require build and test:binary.
- Public owner: emersoftware. Release binaries through GitHub Releases and
  distribute the formula through emersoftware/homebrew-tap.
- Write all code comments in English. Preserve upstream attribution when editing.
- apps/site is retained upstream reference material; it has its own lockfile.
