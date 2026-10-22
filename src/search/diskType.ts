/**
 * 旋转介质（HDD）探测——决定要不要让超大文件走并行分块。
 *
 * 为什么需要：分块 = W 路并发读同一文件的不同偏移。SSD/NVMe 上这是纯赚，机械盘
 * 上每一路都是一次寻道，顺序读退化成随机读，实测能反过来慢好几倍。这是整套
 * 并行分块方案里**唯一会反向恶化**的场景，所以值得在启动时探一次。
 *
 * 平台能力（能拿到就用，拿不到返回 unknown，行为跟现在一致）：
 * - **Linux**：`/proc/self/mountinfo` 找到工作区所在的挂载点 → 块设备 →
 *   `/sys/block/<dev>/queue/rotational`（1 = 旋转）。纯文件读取，亚毫秒级。
 *   容器 / overlay 里拿不到设备名时，退回扫 `/sys/block` 汇总所有盘。
 * - **Windows**：`Get-PhysicalDisk` 的 `MediaType`（HDD / SSD）。它只能给出整机
 *   所有物理盘的集合，所以结果是 hdd / ssd / mixed 三态。需要一次 PowerShell
 *   启动，所以只在扩展激活时预热一次，绝不在搜索路径上等它。
 * - **macOS**：`diskutil info /` 的 "Solid State" 字段。
 *
 * 探测结果进程内缓存；`currentDiskProbe()` 永远同步返回——没预热完就是
 * unknown，搜索不会为了等一次 spawn 而卡住。
 */
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export type DiskKind = 'ssd' | 'hdd' | 'mixed' | 'unknown';

export interface DiskProbe {
  kind: DiskKind;
  /** 判定来源（写日志 / 排障用）：sysfs、Get-PhysicalDisk、diskutil… */
  source: string;
  /** 具体设备，例如 sda / nvme0n1 */
  detail?: string;
}

const UNKNOWN: DiskProbe = { kind: 'unknown', source: 'not probed' };

/** `flySearch.diskType` 的取值 */
export type DiskPreference = 'auto' | 'ssd' | 'hdd';

/**
 * 允许分块吗（纯决策，UI 与测试共用）。
 *
 * - 手动选 ssd：无论探测到什么都分块（探测可能因权限 / 容器而失准）。
 * - 手动选 hdd：一律不分块，退回串行流式。
 * - auto：hdd / mixed 都不分块。mixed 取保守——混合盘上无法确定工作区落在
 *   哪一块，宁可少一次加速，不要在一次搜索里把机械盘打成随机读。
 */
export function resolveChunking(kind: DiskKind, preference: string | undefined): boolean {
  if (preference === 'ssd') {
    return true;
  }
  if (preference === 'hdd') {
    return false;
  }
  return kind !== 'hdd' && kind !== 'mixed';
}

/** 解析 `/sys/block/<dev>/queue/rotational` 的内容。 */
export function parseRotational(text: string): DiskKind | undefined {
  const value = text.trim();
  if (value === '1') {
    return 'hdd';
  }
  if (value === '0') {
    return 'ssd';
  }
  return undefined;
}

/**
 * 块设备名 → `/sys/block` 下的目录名。
 *
 * `/dev/sda1` → `sda`；`/dev/nvme0n1p3` → `nvme0n1`；`/dev/mmcblk0p1` →
 * `mmcblk0`。`/dev/mapper/*`（LVM）与 `/dev/dm-*` 在这里无法反查，调用方会走
 * 全盘汇总那条路。
 */
export function blockBase(device: string): string {
  const name = device.replace(/^\/dev\//, '');
  if (name.startsWith('mapper/') || name.startsWith('dm-')) {
    return '';
  }
  // 已经是整盘名（NVMe / mmcblk / md / loop 本身就以数字结尾）：原样返回，
  // 否则下面那条「去掉末尾数字」会把 nvme0n1 削成 nvme0n。
  if (/^(?:nvme\d+n\d+|mmcblk\d+|md\d+|loop\d+)$/.test(name)) {
    return name;
  }
  const withPartition = /^((?:nvme\d+n\d+|mmcblk\d+|md\d+))p\d+$/.exec(name);
  if (withPartition) {
    return withPartition[1];
  }
  return name.replace(/\d+$/, '');
}

/**
 * 从 `/proc/self/mountinfo` 里找覆盖 `target` 的挂载点，返回其设备路径。
 *
 * 一行长这样（字段用空格分隔，`-` 之后是文件系统来源）：
 * `36 35 98:0 / /home rw,relatime shared:1 - ext4 /dev/sda1 rw`
 *
 * 取**最长前缀**的挂载点：`/` 和 `/home` 都能覆盖 `/home/me`，后者才是对的。
 */
export function deviceFromMountInfo(mountInfo: string, target: string): string | undefined {
  // 这里必须用 POSIX 归一，不能用 path.resolve：mountinfo 是 Linux 的格式，
  // 而这段代码在 Windows 上也要能跑（单测就在 Windows 上跑）——path.resolve
  // 会把 /etc/hosts 变成 C://etc//hosts，前缀比较全废。
  const normalized = normalizePosix(target);
  let best: { mount: string; device: string } | undefined;
  for (const line of mountInfo.split('\n')) {
    const dash = line.indexOf(' - ');
    if (dash < 0) {
      continue;
    }
    const left = line.slice(0, dash).split(' ');
    const right = line.slice(dash + 3).split(' ');
    if (left.length < 5 || right.length < 2) {
      continue;
    }
    const mountPoint = normalizePosix(decodeMountField(left[4]));
    const device = right[1];
    if (!device.startsWith('/dev/')) {
      continue;
    }
    const covers =
      normalized === mountPoint ||
      normalized.startsWith(mountPoint === '/' ? '/' : `${mountPoint}/`);
    if (!covers) {
      continue;
    }
    if (!best || mountPoint.length > best.mount.length) {
      best = { mount: mountPoint, device };
    }
  }
  return best?.device;
}

/** 把任意路径归一成 POSIX 形式（反斜杠转正斜杠、去掉末尾斜杠）。 */
function normalizePosix(value: string): string {
  const forward = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return forward === '' ? '/' : forward;
}

/** mountinfo 里空格写成 `\040`，反斜杠写成 `\134`。 */
function decodeMountField(field: string): string {
  return field.replace(/\\040/g, ' ').replace(/\\134/g, '\\');
}

/**
 * 解析 `Get-PhysicalDisk | Select-Object -ExpandProperty MediaType` 的输出。
 *
 * 输出是每行一个介质类型：`HDD` / `SSD` / `Unspecified`。据此给出三态：
 * 全是 HDD → hdd，全是 SSD → ssd，混装 → mixed，一个都认不出 → unknown。
 */
export function parsePhysicalDisk(output: string): DiskKind {
  let hdd = 0;
  let ssd = 0;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim().toUpperCase();
    if (line === 'HDD') {
      hdd += 1;
    } else if (line === 'SSD') {
      ssd += 1;
    }
  }
  if (hdd > 0 && ssd > 0) {
    return 'mixed';
  }
  if (hdd > 0) {
    return 'hdd';
  }
  if (ssd > 0) {
    return 'ssd';
  }
  return 'unknown';
}

/** 解析 `diskutil info /` 的 `Solid State` 字段。 */
export function parseDiskutil(output: string): DiskKind {
  const match = /Solid State:\s*(Yes|No)/i.exec(output);
  if (!match) {
    return 'unknown';
  }
  return match[1].toLowerCase() === 'yes' ? 'ssd' : 'hdd';
}

/** 扫 `/sys/block` 下所有真实磁盘，汇总成三态（拿不到挂载点时兜底）。 */
export async function scanRotationalAll(sysBlock = '/sys/block'): Promise<DiskProbe> {
  let names: string[];
  try {
    names = await readdir(sysBlock);
  } catch {
    return UNKNOWN;
  }
  let hdd = 0;
  let ssd = 0;
  for (const name of names) {
    if (/^(loop|ram|zram|sr|dm-|md\d)/.test(name)) {
      continue;
    }
    try {
      const kind = parseRotational(await readFile(path.join(sysBlock, name, 'queue', 'rotational'), 'utf8'));
      if (kind === 'hdd') {
        hdd += 1;
      } else if (kind === 'ssd') {
        ssd += 1;
      }
    } catch {
      // 这一块没有 rotational（虚拟设备），跳过
    }
  }
  if (hdd > 0 && ssd > 0) {
    return { kind: 'mixed', source: 'sysfs (all disks)' };
  }
  if (hdd > 0) {
    return { kind: 'hdd', source: 'sysfs (all disks)' };
  }
  if (ssd > 0) {
    return { kind: 'ssd', source: 'sysfs (all disks)' };
  }
  return UNKNOWN;
}

/** 带超时地跑一条命令，失败/超时返回 undefined（探测绝不让调用方抛错）。 */
function runCommand(file: string, args: string[], timeoutMs = 3000): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      resolve(stdout);
    });
  });
}

async function probeLinux(target: string): Promise<DiskProbe> {
  let device: string | undefined;
  try {
    device = deviceFromMountInfo(await readFile('/proc/self/mountinfo', 'utf8'), target);
  } catch {
    // 极简容器里可能没有 mountinfo
  }
  const base = device ? blockBase(device) : '';
  if (base) {
    try {
      const kind = parseRotational(await readFile(`/sys/block/${base}/queue/rotational`, 'utf8'));
      if (kind) {
        return { kind, source: 'sysfs', detail: base };
      }
    } catch {
      // LVM / 设备已卸载：往下走全盘汇总
    }
  }
  return scanRotationalAll();
}

async function probeOnce(target: string): Promise<DiskProbe> {
  if (process.platform === 'linux') {
    return probeLinux(target);
  }
  if (process.platform === 'win32') {
    const out = await runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-PhysicalDisk | Select-Object -ExpandProperty MediaType',
    ]);
    if (out === undefined) {
      return { kind: 'unknown', source: 'Get-PhysicalDisk unavailable' };
    }
    return { kind: parsePhysicalDisk(out), source: 'Get-PhysicalDisk' };
  }
  if (process.platform === 'darwin') {
    const out = await runCommand('diskutil', ['info', '/']);
    if (out === undefined) {
      return { kind: 'unknown', source: 'diskutil unavailable' };
    }
    return { kind: parseDiskutil(out), source: 'diskutil' };
  }
  return { kind: 'unknown', source: `${process.platform}: unsupported` };
}

let cached: DiskProbe | undefined;
let inflight: Promise<DiskProbe> | undefined;

/** 同步读缓存：没探测过 / 还没探完都返回 unknown。 */
export function currentDiskProbe(): DiskProbe {
  return cached ?? UNKNOWN;
}

/** 探测一次（并发调用共享同一次探测）。 */
export function probeDiskKind(target?: string): Promise<DiskProbe> {
  if (cached) {
    return Promise.resolve(cached);
  }
  if (inflight) {
    return inflight;
  }
  const sample = target ?? os.homedir();
  inflight = probeOnce(sample)
    .catch(() => UNKNOWN)
    .then((probe) => {
      cached = probe;
      inflight = undefined;
      return probe;
    });
  return inflight;
}

/** 激活时预热：不阻塞、不抛错，结果供后续搜索读取。 */
export function warmDiskKind(target?: string): void {
  void probeDiskKind(target);
}

/** 测试用：清掉进程内缓存。 */
export function resetDiskProbeCache(): void {
  cached = undefined;
  inflight = undefined;
}
