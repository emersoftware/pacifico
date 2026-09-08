export type Locale = 'en' | 'es';
export const installCommand = 'brew install emersoftware/tap/pacifico && pacifico install';
export const repository = 'https://github.com/emersoftware/pacifico';

export const content = {
  "en": {
    "title": "pacifico — search your coding sessions",
    "description": "Save and search Claude Code, Codex, Pi, and OpenCode conversations on your computer. Give your agents access through MCP.",
    "skip": "Skip to content",
    "nav": [
      "Install",
      "How it works",
      "Guide"
    ],
    "language": "Language",
    "intro": "Save and search your coding sessions.",
    "about": "Read past sessions from your terminal or through your agent with MCP.",
    "terminal": "Install Pacifico",
    "copy": "Copy",
    "copied": "Copied",
    "copyFailed": "Could not copy automatically. Select the command and copy it manually.",
    "requirements": "macOS & Linux · ARM64 & x86-64",
    "sourceIntro": "Reads sessions from",
    "howTitle": "How Pacifico works",
    "howBody": "Pacifico imports the session files your agents already save. You can search those copies after the original files are gone.",
    "flow": [
      {
        "title": "Save a local copy",
        "body": "Import conversations from Claude Code, Codex, Pi, and OpenCode into a separate archive."
      },
      {
        "title": "Search your history",
        "body": "Find messages, files, and commands. Read the conversation around each result."
      },
      {
        "title": "Read sessions from your agent",
        "body": "MCP is the connection that lets your agent search and read the archive. You can also use the terminal."
      }
    ],
    "exampleLabel": "Search by topic",
    "searchCommand": "pacifico \"database migration\"",
    "guideTitle": "Installation guide",
    "guideIntro": "Check the requirements, connect your agents, and choose whether to import sessions automatically.",
    "toc": [
      "Requirements",
      "Agent setup",
      "Automatic imports",
      "Check installation",
      "Troubleshooting",
      "Stored files"
    ],
    "beforeTitle": "Requirements",
    "before": [
      "macOS or Linux, on ARM64 or x86-64.",
      "Homebrew to use the command above. An internet connection to download Pacifico.",
      "Existing sessions from a supported coding agent. No Pacifico account or API key required."
    ],
    "alternative": "To install without Homebrew:",
    "releaseLink": "Download Pacifico",
    "setupTitle": "Connect your agents",
    "setup": [
      "Run the installation command above. It configures Pacifico’s MCP integration.",
      "The installer sets up MCP for detected clients, including Codex, Cursor, and Pi. It registers the Claude Code plugin when available.",
      "Restart your agent to load the integration. Your original session files stay in place."
    ],
    "setupNote": "Automatic imports and session-start hooks are optional. The installer leaves both off.",
    "daemonTitle": "Import sessions automatically",
    "daemonBody": "On macOS, start the daemon to import new and changed sessions every 30 seconds. This background service runs while you’re logged in. The first import may take longer.",
    "daemonLabel": "Start automatic imports",
    "daemonStop": "To stop automatic imports, run",
    "linux": "On Linux, use pacifico daemon run for a single import. Automatic service installation is currently macOS-only.",
    "verifyTitle": "Check the installation",
    "verifyBody": "Run these commands to check the version, archive, and background service.",
    "verifyLabel": "Check installation status",
    "verifyNote": "After you start the daemon, look for installed: true and scheduled: true. A completed lastRun with ok: true means the import succeeded.",
    "recoverTitle": "Troubleshooting",
    "recover": [
      {
        "title": "Your agent cannot find Pacifico",
        "body": "Run the installer again. Then restart your agent.",
        "command": "pacifico install"
      },
      {
        "title": "Sessions are no longer importing",
        "body": "On macOS, start the service again. Then check its status.",
        "command": "pacifico daemon start\npacifico daemon status"
      },
      {
        "title": "Update Pacifico",
        "body": "This command updates Pacifico and its agent integrations.",
        "command": "brew upgrade pacifico && pacifico install"
      }
    ],
    "filesTitle": "Where Pacifico stores your data",
    "filesBody": "Pacifico stores and searches sessions on your computer. Your agent may send retrieved text to its model provider. Usage reports may look up prices online.",
    "files": [
      [
        "Archive & memory",
        "~/.local/share/pacifico"
      ],
      [
        "Rebuildable search index",
        "~/.cache/pacifico"
      ],
      [
        "macOS background service",
        "~/Library/LaunchAgents/com.emersoftware.pacifico.plist"
      ]
    ],
    "retention": "Uninstalling removes the integrations and stops the daemon. It keeps archived sessions and memory. Pacifico cannot recover a session deleted before its first import.",
    "uninstall": "Uninstall Pacifico",
    "commandsTitle": "Commands",
    "commands": [
      [
        "pacifico \"database migration\"",
        "Search your session history"
      ],
      [
        "pacifico context",
        "Get context for the current repository"
      ],
      [
        "pacifico vault status",
        "Check the session archive"
      ],
      [
        "pacifico daemon run",
        "Import once, then exit"
      ],
      [
        "pacifico --mcp",
        "Run the MCP server over stdio"
      ],
      [
        "pacifico --help",
        "See the full command reference"
      ]
    ],
    "closeTitle": "Install Pacifico",
    "closeBody": "Restart your agent after installation.",
    "credit": "Inspired by and built on",
    "made": "Made by",
    "footerNote": "Local archive. Open source. MIT.",
    "back": "Back to top",
    "missing": "Page not found",
    "returnHome": "Go to Pacifico"
  },
  "es": {
    "title": "pacifico — busca en tus sesiones de código",
    "description": "Guarda y busca conversaciones de Claude Code, Codex, Pi y OpenCode en tu equipo. Dales acceso a tus agentes mediante MCP.",
    "skip": "Saltar al contenido",
    "nav": [
      "Instalar",
      "Cómo funciona",
      "Guía"
    ],
    "language": "Idioma",
    "intro": "Guarda y busca tus sesiones de código.",
    "about": "Consulta tus sesiones desde la terminal o desde tu agente mediante MCP.",
    "terminal": "Instalar Pacifico",
    "copy": "Copiar",
    "copied": "Copiado",
    "copyFailed": "No pudimos copiar automáticamente. Selecciona el comando y cópialo manualmente.",
    "requirements": "macOS y Linux · ARM64 y x86-64",
    "sourceIntro": "Lee sesiones de",
    "howTitle": "Cómo funciona Pacifico",
    "howBody": "Pacifico importa los archivos de sesión que tus agentes ya guardan. Puedes buscar en esas copias aunque los archivos originales ya no existan.",
    "flow": [
      {
        "title": "Guarda una copia local",
        "body": "Importa conversaciones de Claude Code, Codex, Pi y OpenCode a un archivo separado."
      },
      {
        "title": "Busca en tu historial",
        "body": "Encuentra mensajes, archivos y comandos. Lee la conversación que rodea cada resultado."
      },
      {
        "title": "Consulta sesiones desde tu agente",
        "body": "MCP es la conexión que permite a tu agente buscar y leer el archivo. También puedes usar la terminal."
      }
    ],
    "exampleLabel": "Buscar por tema",
    "searchCommand": "pacifico \"migración de base de datos\"",
    "guideTitle": "Guía de instalación",
    "guideIntro": "Revisa los requisitos, conecta tus agentes y elige si quieres importar sesiones automáticamente.",
    "toc": [
      "Requisitos",
      "Configurar agentes",
      "Importación automática",
      "Verificar instalación",
      "Resolver problemas",
      "Datos guardados"
    ],
    "beforeTitle": "Requisitos",
    "before": [
      "macOS o Linux, en ARM64 o x86-64.",
      "Homebrew para usar el comando de arriba. Conexión a internet para descargar Pacifico.",
      "Sesiones existentes de un agente compatible. No necesitas una cuenta ni una clave API de Pacifico."
    ],
    "alternative": "Para instalar sin Homebrew:",
    "releaseLink": "Descargar Pacifico",
    "setupTitle": "Conecta tus agentes",
    "setup": [
      "Ejecuta el comando de instalación de arriba. Configura la integración MCP de Pacifico.",
      "El instalador configura MCP para los clientes que detecta, incluidos Codex, Cursor y Pi. Registra el plugin de Claude Code cuando está disponible.",
      "Reinicia tu agente para cargar la integración. Los archivos originales de tus sesiones quedan en su lugar."
    ],
    "setupNote": "La importación automática y los hooks de inicio de sesión son opcionales. El instalador deja ambos desactivados.",
    "daemonTitle": "Importa sesiones automáticamente",
    "daemonBody": "En macOS, activa el daemon para importar sesiones nuevas y modificadas cada 30 segundos. Este servicio funciona en segundo plano mientras tu sesión está abierta. La primera importación puede tardar más.",
    "daemonLabel": "Activar importación automática",
    "daemonStop": "Para detener la importación automática, ejecuta",
    "linux": "En Linux, usa pacifico daemon run para una sola importación. La instalación automática del servicio está disponible solo en macOS.",
    "verifyTitle": "Verifica la instalación",
    "verifyBody": "Ejecuta estos comandos para revisar la versión, el archivo y el servicio en segundo plano.",
    "verifyLabel": "Revisar estado de instalación",
    "verifyNote": "Después de activar el daemon, busca installed: true y scheduled: true. Un lastRun completado con ok: true indica que la importación terminó sin errores.",
    "recoverTitle": "Resolver problemas",
    "recover": [
      {
        "title": "Tu agente no encuentra Pacifico",
        "body": "Ejecuta el instalador otra vez. Luego reinicia tu agente.",
        "command": "pacifico install"
      },
      {
        "title": "Las sesiones ya no se importan",
        "body": "En macOS, activa el servicio otra vez. Luego consulta su estado.",
        "command": "pacifico daemon start\npacifico daemon status"
      },
      {
        "title": "Actualizar Pacifico",
        "body": "Este comando actualiza Pacifico y las integraciones con tus agentes.",
        "command": "brew upgrade pacifico && pacifico install"
      }
    ],
    "filesTitle": "Dónde guarda Pacifico tus datos",
    "filesBody": "Pacifico guarda y busca sesiones en tu equipo. Tu agente puede enviar el texto recuperado a su proveedor de modelos. Los reportes pueden consultar precios por internet.",
    "files": [
      [
        "Archivo y memoria",
        "~/.local/share/pacifico"
      ],
      [
        "Índice de búsqueda reconstruible",
        "~/.cache/pacifico"
      ],
      [
        "Servicio de macOS",
        "~/Library/LaunchAgents/com.emersoftware.pacifico.plist"
      ]
    ],
    "retention": "Desinstalar elimina las integraciones y detiene el daemon. Conserva las sesiones archivadas y la memoria. Pacifico no puede recuperar una sesión eliminada antes de su primera importación.",
    "uninstall": "Desinstalar Pacifico",
    "commandsTitle": "Comandos",
    "commands": [
      [
        "pacifico \"migración de base de datos\"",
        "Buscar en tu historial de sesiones"
      ],
      [
        "pacifico context",
        "Recuperar contexto del repositorio actual"
      ],
      [
        "pacifico vault status",
        "Revisar las sesiones archivadas"
      ],
      [
        "pacifico daemon run",
        "Importar una vez y terminar"
      ],
      [
        "pacifico --mcp",
        "Ejecutar el servidor MCP por stdio"
      ],
      [
        "pacifico --help",
        "Ver la referencia completa de comandos"
      ]
    ],
    "closeTitle": "Instala Pacifico",
    "closeBody": "Reinicia tu agente después de instalar.",
    "credit": "Inspirado en y construido sobre",
    "made": "Hecho por",
    "footerNote": "Archivo local. Código abierto. MIT.",
    "back": "Volver arriba",
    "missing": "Página no encontrada",
    "returnHome": "Ir a Pacifico"
  }
} as const;
