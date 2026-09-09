import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

// Production dependencies point toward the session engine. Integration tests may
// cross these boundaries because they verify the assembled product.
const layers = [
  { directory: 'packages/core/src', allowed: new Set(['core']) },
  { directory: 'packages/agents/src', allowed: new Set(['core', 'agents']) },
  { directory: 'apps/cli/src', allowed: new Set(['core', 'agents', 'cli']) },
];
const failures: string[] = [];
let checked = 0;
for (const layer of layers) {
  for (const path of new Bun.Glob('**/*.ts').scanSync(layer.directory)) {
    if (path.endsWith('.test.ts')) continue;
    const file = `${layer.directory}/${path}`;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    checked++;
    function inspect(node: ts.Node): void {
      let specifier: ts.Expression | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        specifier = node.arguments[0];
      }
      if (specifier && ts.isStringLiteral(specifier)) {
        const spec = specifier.text;
        const target = spec.match(/^@pacifico\/([^/]+)/)?.[1];
        if (target && !layer.allowed.has(target)) failures.push(`${file}: forbidden dependency ${spec}`);
        if (layer.directory === 'packages/core/src') {
          const origin = path === 'vault/archive.ts' ? 'storage' : path.split('/')[0];
          const coreRoot = resolve(layer.directory);
          const resolved = spec.startsWith('.')
            ? resolve(file, '..', spec)
            : spec.startsWith('@pacifico/core/')
              ? resolve(coreRoot, spec.slice('@pacifico/core/'.length))
              : null;
          if (resolved && ['sources', 'storage', 'ingestion'].includes(origin!)) {
            const forbidden =
              resolved === resolve(coreRoot, 'cache') ||
              resolved === resolve(coreRoot, 'cache.ts') ||
              resolved.startsWith(resolve(coreRoot, 'retrieval') + '/');
            if (forbidden)
              failures.push(`${file}: native readers, storage, and ingestion must not depend on retrieval (${spec})`);
            if (['sources', 'storage'].includes(origin!) && resolved.startsWith(resolve(coreRoot, 'ingestion') + '/')) {
              failures.push(`${file}: native readers and storage must not depend on ingestion (${spec})`);
            }
          }
        }
        if (spec.startsWith('.')) {
          const targetPath = resolve(file, '..', spec);
          for (const other of layers) {
            if (other !== layer && targetPath.startsWith(resolve(other.directory) + '/')) {
              failures.push(`${file}: use a workspace import instead of ${spec}`);
            }
          }
        }
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
}
if (failures.length) throw new Error(failures.join('\n'));
process.stdout.write(`Architecture: ${checked} production modules checked.\n`);
