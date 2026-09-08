# Mosaic: funcionamiento observado

Investigación del 2026-09-05. No se accedió al código de su backend.

## Instalación y componentes

La [guía pública](https://mosaic.inc/install) documenta autorización en navegador,
selección de equipo, detección de fuentes, registro de `com.ocean.daemon`,
preparación de una réplica local y skills. Declara que no instala hooks ni
servidores MCP. El montaje visible del archivo es `~/.mosaic`; estado y servicio
viven en Application Support/Ocean y LaunchAgents. La sincronización se ejecuta
mientras la persona está conectada a macOS.

La [fórmula 0.2.24](https://github.com/emergent-inc/homebrew-tap/blob/main/Formula/mosaic.rb)
distribuye `ocean`, `orgtrace`, `rclone` y `Ocean.app`; crea el alias `mosaic`.
También contempla `node` y `ocean.mjs` cuando están presentes. Instala artefactos
precompilados, no compila necesariamente código fuente en la máquina usuaria.

En el Mac se observó esa versión: `mosaic` apunta a `ocean`; `orgtrace` también;
`ocean` es un ejecutable Mach-O arm64 de unos 145 MB y `rclone` unos 82 MB.
Una inspección de cadenas del ejecutable muestra JavaScript empaquetado y Ink.
Eso confirma código JavaScript distribuido; **no demuestra que todo el producto,
la app nativa o el backend estén escritos en TypeScript**. La guía pública
también llama Ink a la interfaz de instalación.

## Organización del archivo

El skill de Mosaic instalado, `mosaic/references/sessions.md`, documenta:

```text
~/.mosaic/
  SessionIndex/<owner>/<agent>/<project>/<session-id>.json
  People/<owner>/<agent>/<provider-native-relative-path>
```

El catálogo contiene metadatos y referencias al contenido. Una sesión puede
tener varios objetos. Las consultas empiezan por metadatos y leen solo los
archivos seleccionados. El documento identifica el almacenamiento remoto como
autoritativo y el árbol local como réplica de solo lectura, susceptible de
hidratación o desalojo. No se recorrió el contenido privado de People.

La combinación de documentación y binarios es coherente con este flujo:

```text
fuentes nativas → recolección local → almacenamiento remoto del equipo
                                      ↓
                             réplica local + catálogo
                                      ↓
                            lectura por CLI / skill
```

El flujo es una síntesis de evidencia, no una reproducción de su implementación.
La presencia de rclone no revela por sí sola el proveedor cloud ni su esquema.

## Lo que no está establecido

- Lenguaje, base de datos y despliegue del backend.
- Transporte exacto, ventanas de debounce y política de reconciliación.
- Detalle de cifrado y autorización por objeto.
- Algoritmos de deduplicación y manejo de truncamientos/concurrencia.
- Precio vigente público o unidad de facturación de los US$99 reportados.
- Implementación completa de forks por proveedor.

## Implicación para Pacifico

La utilidad personal se puede cubrir con archivo local y búsqueda sin backend.
La colaboración de Mosaic añade problemas reales de identidad, consistencia,
permisos y operación. No se debe llamar a este refactor un clon completo de
Mosaic ni usar su marca, código empaquetado o servicios como dependencias.
