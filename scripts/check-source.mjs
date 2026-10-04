import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const ignored = new Set(['.git', 'node_modules', 'release', '.gradle', 'build']);
const generated = /^apps\/(wallet|extension)\/dist(?:-[^/]+)?$/;

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    const path = relative(root, full).split('\\').join('/');
    if (ignored.has(entry.name) || generated.test(path) ||
        path === 'apps/mobile/android/local.properties' ||
        path === 'apps/mobile/android/app/src/main/assets/public') return [];
    return entry.isDirectory() ? files(full) : [path];
  });
}

const expected = JSON.parse(readFileSync(join(root, 'source-files.json'), 'utf8'));
const actual = (existsSync(join(root, '.git'))
  ? execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' }).split('\0').filter(Boolean)
  : files(root)).sort();
const wanted = new Set(expected.map((entry) => entry.path));
const present = new Set(actual);
const added = actual.filter((path) => !wanted.has(path));
const missing = expected.filter((entry) => !present.has(entry.path));
const changed = expected.filter((entry) => {
  if (!present.has(entry.path)) return false;
  if (entry.path === 'source-files.json') return entry.sha256 !== null;
  return createHash('sha256').update(readFileSync(join(root, entry.path))).digest('hex') !== entry.sha256;
});
if (added.length || missing.length || changed.length || wanted.size !== expected.length) {
  for (const path of added) console.error(`Unreviewed file: ${path}`);
  for (const entry of missing) console.error(`Missing file: ${entry.path}`);
  for (const entry of changed) console.error(`Unreviewed content: ${entry.path}`);
  if (wanted.size !== expected.length) console.error('Duplicate inventory entry.');
  process.exit(1);
}
console.log(`Source inventory and content verified: ${actual.length} files.`);
