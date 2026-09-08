# Decisiones de alcance y diseño

## Lenguaje: conservar TypeScript

Alternativa A: portar a Go o Rust y reescribir parsers, MCP, memoria y reportes.
Puede reducir el tamaño del runtime, pero vuelve a abrir problemas ya probados.

Alternativa B: mantener TypeScript y compilar con Bun. Conserva 1.185 pruebas y
permite un ejecutable instalable por Homebrew. Se elige B. No hay evidencia de
que cambiar lenguaje resuelva un problema actual del usuario.

## Arquitectura: módulos por conocimiento

Alternativa A: capas generales `domain/application/infrastructure` con interfaces
por cada operación. Hace explícita la inversión de dependencias, pero introducirla
sin consumidores alternativos añade delegación y obliga a aprender más objetos.

Alternativa B: monolito modular en monorepo. Motor encapsula formatos, archivo,
índice y búsqueda; agentes encapsula MCP y configuración de clientes; CLI posee
argumentos e interacción. Se elige B con dependencias en una sola dirección.

Es una estructura limpia y modular, **no una afirmación de Clean Architecture
estricta**: el motor aún contiene funciones heredadas de renderizado y comandos
de reportes. Separarlas sin un consumidor que lo requiera no mejora por sí mismo
el diseño. Futuras extracciones deben esconder información, no mover líneas.

## Distribución y estado

Producto provisional: Pacifico, binario `pacifico`, comando `pacifico install`.
Se mantiene `setup` como alias. Datos nuevos en `~/.local/share/pacifico` e índice
en `~/.cache/pacifico`; el ID de instalación MCP/plugin es `pacifico`.
Los nombres `SESSIONS_*` de variables de entorno se conservan como contrato de
compatibilidad con los fixtures y herramientas heredadas. Se pueden usar para
elegir fuentes y directorios. No se migra ni elimina el archivo de sessions.

Publicación autorizada bajo la cuenta personal `emersoftware`: repositorio
`emersoftware/pacifico`, binarios en GitHub Releases y tap `emersoftware/homebrew-tap`.
La herramienta sigue funcionando localmente, sin un backend compartido.

## Primer uso

El MVP es personal y local. Instalar configura integraciones; la indexación
ocurre al consultar o mediante el daemon opcional. No se activa un LaunchAgent ni un hook por defecto.
Un hook de contexto consume tokens en cada sesión: continúa siendo opt-in.
No se añade autenticación, una suscripción ni un backend para leer archivos.

## Retención

El índice es reconstruible; las transcripciones archivadas y las decisiones de
memoria no lo son. Desinstalar conserva ambos. La separación ya existe upstream
y se preserva. No hay borrado automático por antigüedad en esta entrega.

## Incertidumbres que ameritan una siguiente iteración

El usuario prefirió añadir un daemon. Se implementó un LaunchAgent local
con importaciones cada 30 segundos, activado con `pacifico daemon start`.
Se compararon watchers residentes y programación del sistema; el detalle está
en [DAEMON.md](DAEMON.md). Todavía se puede perder un archivo eliminado antes
de la siguiente pasada. No añadir sincronización cloud antes de definir
identidad entre equipos, redacción de secretos y permisos por proyecto.
