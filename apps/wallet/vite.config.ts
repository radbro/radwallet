import { defineConfig, type Alias } from 'vite';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'node:fs';

// one version, from the root package.json — the manifest is checked against it
// at assemble time, so the UI can never drift from what ships
const VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

const here = (p: string) => new URL(p, import.meta.url).pathname;

const alias: Alias[] = [
  { find: /^@radwallet\/core$/, replacement: here('../../packages/core/src/index.ts') },
];

// Five build targets from one codebase:
//   vite build                    → dist/         (extension popup + PWA)
//   vite build --mode singlefile  → dist-demo/    (one self-contained HTML,
//                                    demo-mode chain data, for phone testing
//                                    anywhere — no server, no network)
//   vite build --mode pages       → ../../docs/   (the live PWA, committed for
//                                    GitHub Pages so phones can install it;
//                                    demo build lands in docs/demo/)
//   vite build --mode android     → dist-mobile/  (the Capacitor WebView build:
//                                    same app as dist/, but no service worker —
//                                    the WebView already serves these files off
//                                    local disk, and a SW on top is a second
//                                    cache to invalidate for no benefit.)
//   vite build --mode background  → dist-bg/       (extension background worker,
//                                    bundled so it can hold the session keyring.
//                                    Emitted as a CLASSIC script so ONE file
//                                    loads both as a Chrome MV3 service worker
//                                    and as a Firefox MV3 event page.)
export default defineConfig(({ mode }) => {
  const single = mode === 'singlefile' || mode === 'pages-demo';
  const mobile = mode === 'android';
  const outDirs: Record<string, string> = {
    singlefile: 'dist-demo',
    android: 'dist-mobile',
    pages: '../../docs',
    'pages-demo': '../../docs/demo',
    background: 'dist-bg',
  };
  if (mode === 'background') {
    return {
      define: { __APP_VERSION__: JSON.stringify(VERSION) },
      build: {
        outDir: outDirs.background,
        emptyOutDir: true,
        target: 'es2022',
        lib: {
          entry: here('./src/background-entry.ts'),
          // classic script, not a module: one bundle then loads BOTH as a
          // Chrome MV3 service worker and as a Firefox MV3 event page.
          formats: ['iife'],
          name: 'radwalletBackground',
          fileName: () => 'background.js',
        },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
      resolve: { alias },
    };
  }
  return {
    base: './',
    plugins: [preact(), ...(single ? [viteSingleFile()] : [])],
    define: {
      __APP_VERSION__: JSON.stringify(VERSION),
      ...(single ? { 'import.meta.env.VITE_DEMO': JSON.stringify('1') } : {}),
      ...(mobile ? { 'import.meta.env.VITE_MOBILE': JSON.stringify('1') } : {}),
    },
    build: {
      outDir: outDirs[mode] ?? 'dist',
      emptyOutDir: true,
      target: 'es2022',
    },
    resolve: { alias },
  };
});
