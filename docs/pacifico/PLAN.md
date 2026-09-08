# Pacifico — etapas y alcance

Nombre provisional elegido por el usuario: **Pacifico**. Fecha: 2026-09-05.

## 1. Clonar

Base: [nicknisi/sessions](https://github.com/nicknisi/sessions), commit
`9f3c401896bb5b5620c07e07063cd235aab3d4a6`, versión 1.29.2, licencia MIT.
Se conserva el historial Git y la atribución. Rama local: `feat/pacifico-monorepo`.
No es un fork del código propietario de Mosaic.

Aceptación: checkout reproducible y pruebas anteriores al refactor registradas.
Resultado inicial: 1.185 pass, 9 skip, 0 fail; 3.607 aserciones.

## 2. Mapear funciones

Entregable: [FEATURES.md](FEATURES.md). Distingue lo heredado, lo añadido y
lo que sigue fuera del producto local. La migración preserva los parsers y la
búsqueda existentes; no sustituye un sistema probado por un esqueleto.

## 3. Mapear Mosaic a bajo nivel

Entregable: [MOSAIC.md](MOSAIC.md). Se triangulan documentación pública, fórmula
Homebrew y archivos del programa instalado. No se leen credenciales ni se
modifica su sincronización. Lo no observable se etiqueta como desconocido.

## 4. Mapear tecnologías

Entregable: [TECHNOLOGY.md](TECHNOLOGY.md). Separa lenguaje, runtime,
almacenamiento, protocolo y distribución. Homebrew es distribución, no lenguaje.

## 5. Shaping

Entregable: [DECISIONS.md](DECISIONS.md). Se comparan dos diseños antes de
elegir. La primera entrega es una herramienta personal y local, sin backend.
El namespace público elegido posteriormente es `emersoftware`, sin organización.

## 6. Diseñar el monorepo

Entregable: [ARCHITECTURE.md](ARCHITECTURE.md). Límites por conocimiento:
motor de sesiones, integración con agentes y experiencia de terminal.
No se introduce una jerarquía de servicios, repositorios e interfaces vacías.

## 7. Ejecutar y verificar

Aplicación del skill [ousterhout-software-design](https://github.com/ia-revi/skills/blob/main/skills/ousterhout-software-design/SKILL.md).
Se leyó el skill, su cheatsheet y el capítulo 11. Criterios aplicados:
ocultar decisiones internas; no crear capas que solo delegan; comparar diseños;
mantener módulos profundos; medir y verificar antes de afirmar mejoras.

Aceptación: tipos, lint, formato, pruebas existentes, compilación y un recorrido
real del binario con instalación, MCP, búsqueda, archivo y desinstalación en
directorios de prueba. El artefacto y su tap deben poder prepararse sin inventar
URLs públicas ni checksums. Los resultados finales están en [VALIDATION.md](VALIDATION.md).

## Trabajo posterior al alcance local

- Sincronización entre computadores: primero identidad estable de sesiones,
  manifests y transporte; después autorización y reconciliación.
- Equipos: permisos por proyecto, invitaciones, retención, auditoría y handoffs.
- Daemon: implementado posteriormente a petición del usuario; consultar [DAEMON.md](DAEMON.md).
- Portar a Go/Rust solo si mediciones de memoria, arranque o distribución lo justifican.
- La web heredada es material de referencia; falta diseñar la identidad pública de Pacifico.
