// Deterministic extension packaging: same source -> byte-identical zips.
// Pack Chrome dist/ and Firefox dist-firefox/.
// Fixed mtimes, sorted entries, no zlib timestamps. Prints SHA-256 of the
// zip and of every file so a store artifact can be diffed against source.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '../release');

// Write one reproducible artifact for each browser.
const TARGETS = [
  { name: 'chrome', dist: join(here, '../apps/extension/dist'), suffix: '' },
  { name: 'firefox', dist: join(here, '../apps/extension/dist-firefox'), suffix: '-firefox' },
];

// ---- tiny deterministic ZIP writer (store-only, fixed timestamps) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// fixed timestamp: 2026-01-01 00:00:00 (DOS format)
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; }

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).split('\\').join('/'));
  }
  return out;
}

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { path, data } of files) {
    const nameBuf = Buffer.from(path, 'utf8');
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0),
      nameBuf, data,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralBuf.length), u32(centralStart), u16(0),
  ]);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ---- build the release ----
const sha = (b) => createHash('sha256').update(b).digest('hex');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const lines = [];
for (const target of TARGETS) {
  if (!existsSync(target.dist)) {
    console.error(`missing ${target.dist} — run \`npm run build\` first`);
    process.exit(1);
  }
  const files = walk(target.dist).map((path) => ({ path, data: readFileSync(join(target.dist, path)) }));
  const zipBuf = zip(files);
  const version = JSON.parse(readFileSync(join(target.dist, 'manifest.json'), 'utf8')).version;
  const zipName = `radwallet-${version}${target.suffix}.zip`;
  writeFileSync(join(outDir, zipName), zipBuf);

  lines.push(`${sha(zipBuf)}  ${zipName}`);
  for (const f of files) lines.push(`${sha(f.data)}  ${target.name}/${f.path}`);

  console.log(`packed ${files.length} files -> release/${zipName}`);
  console.log(`  ${target.name} zip sha256: ${sha(zipBuf)}`);
}
writeFileSync(join(outDir, 'SHASUMS'), lines.join('\n') + '\n');
