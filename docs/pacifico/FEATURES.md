# Mapa de funciones

Base verificada en el checkout de `nicknisi/sessions` indicado en PLAN.md.
Las ubicaciones corresponden al monorepo resultante.

| Función                     | Implementación Pacifico                                               | Situación frente a Mosaic                                                                                      |
| --------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Claude y Codex              | `packages/core/src/parser.ts`, `scanner.ts`, `cache.ts`               | Ambos leen fuentes nativas; no asumir paridad entre formatos                                                   |
| Pi y OpenCode               | `pi-tree.ts`, `opencode.ts`, parsers de reportes                      | Heredado; Mosaic documenta más proveedores                                                                     |
| Búsqueda por mensaje        | SQLite FTS5 en `cache.ts`; ranking BM25                               | Pacifico lo hereda; el skill de Mosaic indica que no tiene búsqueda textual general del archivo local completo |
| Búsqueda exhaustiva         | `grepSessions`, literal o regex, con índices de mensaje               | Heredado                                                                                                       |
| Lectura contextual          | Paginación y digest en `parser.ts`, `digest.ts`                       | Heredado; Mosaic usa catálogo y archivos nativos                                                               |
| Archivo duradero            | `vault/archive.ts`, manifest y copias locales                         | Heredado; no es captura continua mientras Pacifico está cerrado                                                |
| Actualización incremental   | `cache.ts`: compara tamaño/mtime y procesa archivos cambiados         | Incremental por archivo; no prometer append-only por offset para todos los proveedores                         |
| Memorias curadas            | `memory/`: candidatos, aprobación, alcance, export/import             | Heredado; no equivale a sincronización del historial entre equipos                                             |
| MCP                         | `packages/agents/src/mcp.ts`: 12 herramientas, recursos y prompts     | Heredado; Mosaic actual instala skills, no MCP                                                                 |
| Skills                      | `packages/agents/plugin/skills/`: 7 directorios                       | Heredado y comandos adaptados a Pacifico                                                                       |
| Métricas y reportes         | `report/`, `wrapped/`                                                 | Heredado; reportes pueden actualizar precios por red                                                           |
| Semántica                   | `semantic/`: Ollama opcional y fusión de resultados                   | Heredado; no requiere modelo para búsqueda textual                                                             |
| Reanudación                 | `buildResumeCommand` y selector                                       | Heredado; no garantiza fork nativo fiel en todos los agentes                                                   |
| Instalación                 | `pacifico install`, alias `setup`; configuración de clientes y plugin | Añadido nombre/comando Pacifico; conserva manejo de conflictos y backups                                       |
| Distribución                | Bun compile; scripts y tap Homebrew                                   | Preparado para binarios; publicar requiere repositorio y release reales                                        |
| Equipos, auth, permisos     | No implementado                                                       | Mosaic sí documenta equipos y autorización                                                                     |
| Daemon y réplica compartida | LaunchAgent local cada 30s; réplica compartida pendiente              | Mosaic usa LaunchAgent y réplica local                                                                         |
| Handoff y notificación      | No implementado                                                       | Mosaic lo documenta; no es parte del MVP personal                                                              |

## Flujo local

Una consulta descubre fuentes, refresca los archivos cambiados y preserva copias
en el archivo duradero; luego consulta el índice. La respuesta MCP devuelve
fragmentos y referencias que permiten lecturas acotadas. No se usa un LLM para
parsear o buscar palabras. La búsqueda semántica usa un servicio de embeddings
opcional y tiene un camino de búsqueda textual cuando no está disponible.

## Límites relevantes

Guardar un archivo no equivale a entender su árbol de mensajes: subagentes,
ramas de Pi y resultados grandes están contemplados en código y pruebas. Se
conservó ese código. La compatibilidad futura con cambios de Claude/Codex exige
mantenimiento; la prueba de fixtures no demuestra compatibilidad universal con
cualquier versión del agente. Las nueve pruebas opt-in no corrieron en la base.
