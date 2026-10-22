import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  logLevel: 'error',
});

// Worker 脚本也打进 dist，线程池测试直接用它起线程
await build({
  entryPoints: ['src/search/workerMain.ts'],
  bundle: true,
  outfile: 'dist/searchWorker.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'error',
});

await build({
  entryPoints: ['src/search/walkWorker.ts'],
  bundle: true,
  outfile: 'dist/walkWorker.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'error',
});

await build({
  entryPoints: ['src/search/workerPool.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: 'test/.tmp/workerPool.mjs',
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  logLevel: 'error',
});

for (const [entry, outfile] of [
  ['src/engine/wasm.ts', 'test/.tmp/wasm.mjs'],
  ['src/engine/search.ts', 'test/.tmp/search.mjs'],
  ['src/ui/html.ts', 'test/.tmp/html.mjs'],
  ['src/i18n-core.ts', 'test/.tmp/i18n-core.mjs'],
  ['src/search/glob.ts', 'test/.tmp/glob.mjs'],
  ['src/search/history.ts', 'test/.tmp/history.mjs'],
  ['src/search/stream.ts', 'test/.tmp/stream.mjs'],
  ['src/search/parallelism.ts', 'test/.tmp/parallelism.mjs'],
  ['src/search/diskType.ts', 'test/.tmp/diskType.mjs'],
  ['src/search/exactCount.ts', 'test/.tmp/exactCount.mjs'],
  ['src/search/chunkPlan.ts', 'test/.tmp/chunkPlan.mjs'],
  ['src/search/inputHistory.ts', 'test/.tmp/inputHistory.mjs'],
  ['src/search/preview.ts', 'test/.tmp/preview.mjs'],
  ['src/search/walkSession.ts', 'test/.tmp/walkSession.mjs'],
  ['src/search/dirPriority.ts', 'test/.tmp/dirPriority.mjs'],
]) {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    // 依赖里有 CJS 包（iconv-lite）会走 esbuild 的 __require，
    // ESM 产物里没有 require，必须用 createRequire 补一个。
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
    },
    logLevel: 'error',
  });
}
