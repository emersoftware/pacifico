# Technology

| Area               | Implementation                                                |
| ------------------ | ------------------------------------------------------------- |
| Source language    | TypeScript                                                    |
| CLI runtime        | Bun, embedded in release executables                          |
| Terminal           | Existing selector with optional fzf and a built-in fallback   |
| Storage            | Bun SQLite, FTS5, native transcript snapshots, and a manifest |
| Agent integration  | MCP SDK, stdio, and Zod schemas                               |
| Distribution       | Compiled binaries, GitHub Releases, and Homebrew              |
| Website            | Astro, React, Tailwind CSS; separate package and lockfile     |
| Background service | Optional user LaunchAgent on macOS                            |

Homebrew can distribute a program written in TypeScript. Bun compilation includes its runtime, so users of the release executable do not need Bun or Node.js installed.

Dependency versions are recorded in lockfiles. The original local baseline used Bun 1.3.6; release and CI workflows use Bun 1.3.13. The website has its own TypeScript and dependency requirements, independent of the executable.

The regular build uses the committed pricing snapshot. Refreshing that data is explicit through `bun run generate-pricing-embed`.

See the official [Bun executable documentation](https://bun.sh/docs/bundler/executables) and [Homebrew Formula Cookbook](https://docs.brew.sh/Formula-Cookbook) for the distribution mechanisms.
