import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const target = 'wasm32-unknown-unknown';
const cargoCandidates = [
  'cargo',
  join(homedir(), '.cargo', 'bin', 'cargo.exe'),
  join(homedir(), '.cargo', 'bin', 'cargo'),
];

function cargoCommand() {
  for (const candidate of cargoCandidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', shell: true });
    if (probe.status === 0) {
      return candidate;
    }
  }
  console.error('cargo not found. Install Rust from https://rustup.rs first.');
  process.exit(1);
}

const cargo = cargoCommand();
console.log(`[wasm] using ${cargo}`);

const buildResult = spawnSync(
  cargo,
  ['build', '--release', '--target', target, '--manifest-path', join('rust-core', 'Cargo.toml')],
  { stdio: 'inherit', shell: true },
);

if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}

const artifact = join('rust-core', 'target', target, 'release', 'search_core.wasm');
if (!existsSync(artifact)) {
  console.error(`[wasm] artifact missing: ${artifact}`);
  process.exit(1);
}

mkdirSync('media', { recursive: true });
copyFileSync(artifact, join('media', 'core.wasm'));
console.log(`[wasm] media/core.wasm ${(statSync(join('media', 'core.wasm')).size / 1024).toFixed(1)} KB`);
