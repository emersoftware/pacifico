# Importación en segundo plano

El servicio local de Pacifico mantiene el índice y el archivo aunque no haya una
consulta MCP abierta. En macOS usa un LaunchAgent del usuario, sin sudo.

Desde el repositorio, después de `bun run build`:

```sh
./dist/pacifico daemon start
./dist/pacifico daemon status
./dist/pacifico daemon stop
```

Con el binario instalado en PATH se puede usar `pacifico` directamente.
`pacifico daemon run` realiza una sola importación y termina; también sirve en Linux.
`start`, `stop` y la consulta de registro del servicio requieren macOS.
La instalación MCP y la activación del servicio son operaciones independientes.

## Decisión de diseño

Se compararon un proceso residente con watchers y un trabajo periódico de
launchd. Se eligió launchd con `StartInterval=30`: descubre también archivos
nuevos y recupera cambios que un watcher perdiera. No mantiene una instancia de
Bun en memoria entre pasadas. Usa el importador incremental existente.

Hay una pasada al registrar el servicio y después cada 30 segundos cuando macOS
lo programa. launchd omite un disparo si la pasada anterior continúa ejecutándose;
no crea una cola de procesos. Los intervalos durante suspensión se pierden. El
servicio es por usuario y funciona mientras su sesión esté abierta, no antes del
login. No ofrece captura instantánea: un archivo borrado antes de la próxima
pasada todavía puede perderse.

El plist vive en `~/Library/LaunchAgents/com.emersoftware.pacifico.plist`. Conserva
la ruta absoluta del binario que lo instaló: si se mueve, volver a ejecutar
`daemon start` desde su ubicación definitiva. El estado acotado de la última
pasada queda en `~/.local/share/pacifico/daemon-state.json`; incluye fecha, duración,
cantidades y fallo si lo hubo. No se añade un archivo de logs que crezca sin límite.

Los overrides de fuentes y datos `SESSIONS_*` conocidos se guardan en el plist;
las rutas relativas se convierten en absolutas. No se copia todo el entorno ni
claves API ajenas. Cambiar esos overrides requiere volver a ejecutar `start`.

## Concurrencia y conservación

MCP y el servicio comparten una exclusión SQLite en el archivo, separada del
índice reconstruible. Protege toda la actualización del manifest frente a otros
procesos. El sistema libera el bloqueo incluso tras una terminación abrupta;
no hay archivos PID que puedan quedar obsoletos. Un competidor espera hasta 60
segundos y, si no obtiene el bloqueo, informa del fallo.

Las copias de transcripciones se escriben en archivos temporales y se publican
por rename. Una interrupción conserva la copia anterior completa. El archivo es
el último snapshot, no un historial de versiones ilimitado.

`stop` retira el trabajo programado y su plist. `uninstall` también lo detiene.
Ambos conservan transcripciones archivadas y decisiones de memoria. `start` y
`stop` rechazan sobrescribir/eliminar un plist ajeno sin la marca de Pacifico.

## Verificación

- Prueba de exclusión y de recuperación tras matar al proceso propietario.
- Prueba del plist: argv con espacios/caracteres XML y exclusión de claves API.
- Dos procesos del binario importando concurrentemente.
- Archivo sin consulta, eliminación de la fuente sintética y reconstrucción del índice.
- Prueba real con launchd usando un label único y fuentes temporales; bootstrap,
  actualización y bootout al finalizar. No activa el Pacifico permanente del usuario.

La primera prueba del sistema superó el límite inicial de 20 segundos; una
repetición completó el recorrido. El smoke test permite 45 segundos para absorber
la planificación y arranque en frío del sistema, e imprime diagnóstico si falla.

Las semánticas de programación se verificaron con los manuales locales
`launchd.plist(5)` y `launchctl(1)` del Mac de desarrollo.
