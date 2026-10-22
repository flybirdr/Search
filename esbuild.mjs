import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
};

// 搜索 Worker：独立线程入口，不能 import vscode，单独打包
const workerOptions = {
  entryPoints: ['src/search/workerMain.ts'],
  bundle: true,
  outfile: 'dist/searchWorker.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'info',
};

// 遍历 Worker：同上，独立线程入口
const walkWorkerOptions = {
  entryPoints: ['src/search/walkWorker.ts'],
  bundle: true,
  outfile: 'dist/walkWorker.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
  await build(workerOptions);
  await build(walkWorkerOptions);
}
