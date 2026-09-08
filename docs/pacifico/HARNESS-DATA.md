# Datos que podemos obtener de las sesiones

Fecha: 2026-09-05. Se revisaron los adaptadores actuales y las claves de registros
en el primer MiB de dos archivos recientes de Claude y dos de Codex. Es una
muestra de formatos, no una auditoría completa del historial. No se copió aquí
contenido privado ni valores de credenciales.

## Datos registrados y datos derivados

| Categoría           | Datos disponibles si el harness los escribe                                        | Estado actual                                                                               |
| ------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Conversación        | Mensajes, roles, timestamps, títulos, herramientas y sus resultados                | Búsqueda y lectura disponibles; algunas respuestas se resumen o limitan                     |
| Identidad           | ID de sesión/turno/mensaje, relaciones padre-hijo, harness y versión               | Sesiones unificadas; no todos los identificadores tienen una API pública                    |
| Proyecto            | cwd, repositorio, branch, worktrees y archivos                                     | Filtros por proyecto/archivo; correlación Git en `why`                                      |
| Ejecución           | Herramienta, argumentos, comandos, patches, salidas y errores                      | Extracción de archivos/comandos/errores; una llamada registrada no prueba que tuviera éxito |
| Modelo              | Proveedor/modelo, cambios, esfuerzo, modo y contexto disponible                    | Modelos/uso en reportes; varias opciones de ejecución aún no se normalizan                  |
| Consumo             | Tokens de entrada/salida, caché y, en ciertos formatos, razonamiento               | Reportes existentes; cuidar diferencias de esquema y duplicados                             |
| Tiempo              | Inicio/fin, duración, primer token, pausas e intervenciones                        | Actividad agregada disponible; latencias detalladas pendientes                              |
| Delegación          | Subagentes, tipo, padre, consumo, ramas y forks                                    | Mayor detalle en Claude/Pi; no hay paridad universal                                        |
| Personalización     | Skills, plugins, servidores/herramientas MCP y hooks                               | Parte está en los originales; falta una vista de atribución uniforme                        |
| Contexto y permisos | Instrucciones registradas, sandbox, políticas de aprobación, modos, compactaciones | Conservados cuando aparecen; normalización parcial                                          |

## Diferencias entre harnesses

**Claude Code.** Los parsers actuales leen JSONL y archivos de subagentes. Usan
metadatos de dispatch para atribuir tipos de agente y evitar contar dos veces
respuestas copiadas al reanudar/forkear. En la muestra local aparecieron
`gitBranch`, `parentUuid`, `permissionMode`, `promptSource`, `effort`,
`attributionSkill`, `attributionPlugin`, `attributionMcpServer` y
`attributionMcpTool`. Se observaron también metadatos de compactación/hooks.
La presencia de una clave no garantiza que tenga un valor útil en toda sesión.

**Codex.** El parser de conversaciones entiende distintos eventos y response
items. En la muestra local aparecieron `cli_version`, `context_window`,
`source`, `thread_source`, `effort`, `sandbox_policy`, `approval_policy`,
`permission_profile`, `workspace_roots`, `duration_ms` y
`time_to_first_token_ms`. Son candidatos para ampliar el modelo normalizado.
El extractor actual de thinking devuelve vacío para Codex; no debemos prometer
recuperación de contenido cifrado ni de razonamiento que no se haya registrado
como texto visible.

**Pi.** El código existente reconstruye ramas y relaciones de árbol. El parser de
uso contempla cambios de modelo, compactaciones y branch summaries con consumo.
Puede atribuir ejecuciones de subagentes al padre, aunque el nombre/tipo detallado
no siempre está presente.

**OpenCode.** El adaptador actual lee su SQLite en modo de solo lectura y
reconstruye sesiones/mensajes/partes. Extrae herramientas, estados, modelo,
proveedor, tokens y coste cuando está registrado. La copia duradera es JSONL
normalizado; no equivale a copiar un JSONL nativo del proveedor.

Otros harnesses necesitan sus propios adaptadores. Compartir proveedor/modelo
no significa compartir formato de almacenamiento.

## Hallazgo para el próximo trabajo

Los archivos Codex muestreados incluyen `token_usage_record`, con IDs de
respuesta/turno y campos de consumo más detallados. El parser de reportes actual
está orientado a `event_msg` / `token_count` / `last_token_usage`.
En el primer MiB de ambas muestras coexistían los dos formatos: 12/12 y 10/10
registros, respectivamente. No se deben sumar como consumos independientes.
Antes de afirmar cobertura de consumo en esos formatos hay que mapear su
coexistencia, elegir la fuente autoritativa y deduplicar por IDs. Añadir todos los
contadores sin esas reglas podría duplicar el gasto estimado.

## Qué productos podemos construir encima

- **Memoria de decisiones:** qué se eligió, alternativas y argumentos, con enlaces al mensaje fuente.
- **Reanudación contextual:** último objetivo, archivos afectados, bloqueos y próximo paso.
- **Mapa archivo → sesiones:** encontrar la conversación detrás de un cambio; con Git, vincular commits como correlación.
- **Errores repetidos:** comandos que fallan, bucles de reintentos y correcciones repetidas del usuario.
- **Atribución de herramientas:** qué skills/MCP/subagentes se invocan y con qué latencias, fallos y consumo.
- **Presupuesto por proyecto/tarea/modelo:** consumo registrado y coste estimado, manteniendo visible su cobertura.
- **Historial de contexto:** compactaciones, cambios de modelo y restricciones vigentes en cada turno.

Decisiones, bloqueos, resúmenes y causas son interpretaciones de la evidencia;
pueden combinar heurísticas con un LLM. Deben conservar procedencia y distinguirse
de campos copiados del registro. Tiempo transcurrido no equivale a tiempo de
trabajo humano. Coste calculado con una tarifa no equivale a la factura de una
suscripción. Un test que pasó en una sesión no demuestra el estado actual del repo.

## Código inspeccionado

- `packages/core/src/types.ts`: proyección de búsqueda, contexto y actividad.
- `packages/core/src/parser.ts`, `extract-*`: mensajes, archivos, herramientas y errores.
- `packages/core/src/report/parsers/`: normalización de consumo por harness.
- `packages/core/src/pi-tree.ts`: árbol y forks de Pi.
- `packages/core/src/opencode.ts`: reconstrucción desde SQLite.
- `packages/core/src/why/correlate.ts`: correlaciones con Git y nivel de evidencia.
