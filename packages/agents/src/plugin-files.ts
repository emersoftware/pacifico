// Auto-generated from plugin/ directory. Do not edit manually.
// Regenerate with: bun run generate-plugin-embed

/** Plugin file contents keyed by repo-relative path. */
export interface PluginFileMap {
  [path: string]: string;
}

export const PLUGIN_FILES: PluginFileMap = {
  '.claude-plugin/plugin.json':
    '{\n  "name": "pacifico",\n  "description": "Local session search and reading through MCP.",\n  "version": "0.2.0",\n  "author": {\n    "name": "emersoftware"\n  },\n  "license": "MIT",\n  "keywords": [\n    "pacifico",\n    "sessions",\n    "search",\n    "mcp"\n  ]\n}\n',
  '.codex-plugin/plugin.json':
    '{\n  "name": "pacifico",\n  "description": "Local session search and reading through MCP.",\n  "version": "0.2.0",\n  "author": {\n    "name": "emersoftware"\n  },\n  "license": "MIT",\n  "keywords": [\n    "pacifico",\n    "sessions",\n    "search",\n    "mcp"\n  ],\n  "interface": {\n    "displayName": "Pacifico",\n    "shortDescription": "Search and read local coding sessions",\n    "category": "Productivity"\n  }\n}\n',
  '.cursor-plugin/plugin.json':
    '{\n  "name": "pacifico",\n  "description": "Local session search and reading through MCP.",\n  "version": "0.2.0",\n  "author": {\n    "name": "emersoftware"\n  },\n  "license": "MIT",\n  "keywords": [\n    "pacifico",\n    "sessions",\n    "search",\n    "mcp"\n  ]\n}\n',
  '.mcp.json':
    '{\n  "mcpServers": {\n    "pacifico": {\n      "command": "pacifico",\n      "args": ["--mcp"]\n    }\n  }\n}\n',
};
