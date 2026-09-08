# Tecnologías

| Capa                         | Pacifico                                                   | Mosaic: evidencia disponible                             |
| ---------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| Lenguaje del código editable | TypeScript                                                 | JS empaquetado observado; TS de origen no demostrado     |
| Runtime CLI                  | Bun, incluido en el ejecutable                             | Binario Mach-O; fórmula contempla Node como variante     |
| Terminal                     | Implementación existente + fzf opcional                    | Instalador Ink documentado                               |
| Datos                        | SQLite integrado en Bun, FTS5 y archivo nativo             | Catálogo JSON, artefactos nativos y réplica documentados |
| Agentes                      | SDK MCP, stdio, Zod, skills                                | CLI y skills; sin servidor MCP instalado                 |
| Semántica                    | Ollama opcional                                            | No determinada                                           |
| Distribución                 | Binarios compilados + Homebrew                             | Homebrew/shell + binarios precompilados                  |
| Web heredada                 | Astro, Tailwind; proyecto separado en el mismo repositorio | No auditada                                              |
| Servicio de fondo            | LaunchAgent local opcional cada 30s                        | LaunchAgent, Ocean.app, rclone                           |

Homebrew puede distribuir un ejecutable generado desde TypeScript. Bun incluye
runtime y dependencias al compilar; el usuario final no necesita instalar Bun
para ejecutar el binario. Véase [Bun: ejecutables](https://bun.sh/docs/bundler/executables).
Las fórmulas usan URLs, checksums y pasos de instalación; véase
[Homebrew: Formula Cookbook](https://docs.brew.sh/Formula-Cookbook).

Las versiones efectivas de dependencias se fijan en los lockfiles. El primer
baseline y binario local se ejecutaron con Bun 1.3.6. CI heredada usa 1.3.13.
El sitio conserva su lockfile y compilador propios: no se mezcla su TypeScript 6
con los tipos del programa Bun. Un monorepo no necesita imponer un solo runtime
a productos con requisitos distintos.

La compilación ordinaria consume el snapshot de precios ya versionado. Actualizar
precios es una operación explícita (`generate-pricing-embed`), para que el build
no cambie datos remotos sin relación con el refactor.
