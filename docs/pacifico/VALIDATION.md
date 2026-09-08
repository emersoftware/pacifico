# Validación de la entrega local

Fecha: 2026-09-05. Host: macOS arm64. Bun: 1.3.6.

| Verificación                                    | Resultado                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| Upstream antes del refactor                     | 1.185 pass, 9 skip, 0 fail; 3.607 aserciones                                   |
| Suite después de reorganizar y adaptar Pacifico | 1.185 pass, 9 skip, 0 fail; 3.607 aserciones                                   |
| TypeScript                                      | `bun run typecheck` pasa                                                       |
| Lint                                            | `bun run lint` pasa                                                            |
| Arquitectura                                    | 96 módulos de producción verificados; motor sin dependencias hacia CLI/agentes |
| Compilación                                     | `bun run build` produce `dist/pacifico`                                        |
| Binario + MCP                                   | `bun run test:binary` pasa                                                     |
| Empaquetado                                     | tarball macOS arm64, LICENSE, NOTICE y SHA-256 generados                       |
| Fórmula local                                   | `ruby -c distribution/Formula/pacifico.rb`: Syntax OK                          |
| Web heredada                                    | Astro compila 3 páginas; advertencias por fuentes no generadas                 |

## Recorrido del ejecutable

El smoke test corre el binario compilado, no funciones importadas del código:

1. Crea fuentes Claude sintéticas y una configuración Codex con servidores
   ajenos, incluido uno llamado `sessions`.
2. Ejecuta `install` dos veces; comprueba idempotencia y preservación de los otros servidores.
3. Comprueba que Codex apunta a la ruta absoluta del ejecutable Pacifico.
4. Conecta un cliente MCP por stdio y verifica nombre de servidor y 12 herramientas.
5. Busca una palabra única y lee la respuesta del asistente con schemas validados.
6. Comprueba que la transcripción nativa conserva exactamente sus bytes.
7. Desinstala y verifica que siguen el archivo duradero, la memoria y las entradas ajenas.

La suite heredada cubre, entre otros casos, parsers Claude/Codex, búsqueda,
archivo, subagentes, ramas Pi, memoria, configuración TOML/JSON y ciclo de vida MCP.

## Alcance de la evidencia

- No se instaló Pacifico sobre las configuraciones reales del usuario.
- No se importó todo el historial personal ni se midieron latencia/memoria con varios GiB.
- Las 9 pruebas opt-in de corpus real y Ollama están omitidas; no cuentan como aprobadas.
- El binario de macOS arm64 se ejecutó. La matriz de release contempla otras tres
  plataformas, pero no se ejecutaron sus binarios.
- La fórmula no se instaló con Homebrew; sintaxis válida y binario probado no
  sustituyen esa comprobación. El paquete tiene URL local, no pública.
- La web todavía es referencia upstream, con sus marcas y configuración heredada;
  no se validó su despliegue. Antes de publicar hay que adaptar identidad, rutas
  de hosting y fuentes.
- No se hizo push, release, publicación de tap, despliegue ni cambio de Mosaic.

El checksum vigente está junto al tarball en `dist/` y en la fórmula generada.
Regenerar ambos mediante `bun run package:local` después de reconstruir el binario.

## Ampliación: daemon local

- Suite con daemon: 1.188 pass, 9 skip, 0 fail; 3.617 aserciones.
- Se corrigió el aislamiento de una prueba heredada que leía AGENTS.md del cwd; ahora usa un repo sintético.
- Se añadieron pruebas de bloqueo concurrente, muerte del propietario y generación de plist.
- El smoke del binario importa con dos procesos, elimina la fuente sintética y reconstruye desde el archivo.
- Se probó bootstrap/importación/actualización/bootout real con un LaunchAgent temporal y fuentes sintéticas.
- No quedó un daemon permanente activo sobre el historial del usuario.
