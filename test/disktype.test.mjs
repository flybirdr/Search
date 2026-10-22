/**
 * 磁盘介质探测的纯解析部分 + sysfs 扫描。
 *
 * 真正的 PowerShell / diskutil 调用不测（跑测试时不该 spawn 进程），
 * 这里只锁「给定输出 → 判定」这一段，以及 Linux 那条能离线重放的路径。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  blockBase,
  deviceFromMountInfo,
  parseDiskutil,
  parsePhysicalDisk,
  parseRotational,
  resolveChunking,
  scanRotationalAll,
} from './.tmp/diskType.mjs';

test('rotational：1 = 机械盘，0 = 固态', () => {
  assert.equal(parseRotational('1\n'), 'hdd');
  assert.equal(parseRotational('0\n'), 'ssd');
  assert.equal(parseRotational(''), undefined);
  assert.equal(parseRotational('maybe'), undefined);
});

test('块设备名归一：分区去掉，NVMe / mmcblk 保留 pN 前缀', () => {
  assert.equal(blockBase('/dev/sda1'), 'sda');
  assert.equal(blockBase('/dev/sdb'), 'sdb');
  assert.equal(blockBase('/dev/nvme0n1p3'), 'nvme0n1');
  assert.equal(blockBase('/dev/nvme0n1'), 'nvme0n1');
  assert.equal(blockBase('/dev/mmcblk0p1'), 'mmcblk0');
  assert.equal(blockBase('/dev/md0p1'), 'md0');
  assert.equal(blockBase('/dev/mapper/vg-root'), '', 'LVM 反查不到，交给全盘汇总');
  assert.equal(blockBase('/dev/dm-0'), '');
});

const MOUNTINFO = [
  '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw',
  '31 22 259:3 / /home rw,relatime shared:2 - xfs /dev/nvme0n1p3 rw',
  '32 22 0:40 / /proc rw,nosuid - proc proc rw',
  '33 22 0:41 / /mnt/my\\040disk rw - ext4 /dev/sdc1 rw',
].join('\n');

test('mountinfo：取覆盖目标的最长挂载点', () => {
  assert.equal(deviceFromMountInfo(MOUNTINFO, '/home/lenovo/WorkBuddy'), '/dev/nvme0n1p3');
  assert.equal(deviceFromMountInfo(MOUNTINFO, '/etc/hosts'), '/dev/sda1', '不匹配子目录时退回 /');
  assert.equal(deviceFromMountInfo(MOUNTINFO, '/home'), '/dev/nvme0n1p3');
  assert.equal(deviceFromMountInfo(MOUNTINFO, '/mnt/my disk/x'), '/dev/sdc1', '转义空格要还原');
  assert.equal(deviceFromMountInfo(MOUNTINFO, '/homework'), '/dev/sda1', '/home 不该前缀匹配 /homework');
  assert.equal(deviceFromMountInfo('', '/home'), undefined);
});

test('Get-PhysicalDisk：全 SSD / 全 HDD / 混装 / 认不出', () => {
  assert.equal(parsePhysicalDisk('SSD\r\nSSD\r\n'), 'ssd');
  assert.equal(parsePhysicalDisk('HDD\r\n'), 'hdd');
  assert.equal(parsePhysicalDisk('SSD\r\nHDD\r\n'), 'mixed', '混装取保守，按机械盘处理');
  assert.equal(parsePhysicalDisk('Unspecified\r\n'), 'unknown');
  assert.equal(parsePhysicalDisk(''), 'unknown');
});

test('diskutil：读 Solid State 字段', () => {
  const ssd = '   Device / Media Name:      APPLE SSD AP0512Q\n   Solid State:               Yes\n';
  const hdd = '   Device / Media Name:      ST2000DM008\n   Solid State:               No\n';
  assert.equal(parseDiskutil(ssd), 'ssd');
  assert.equal(parseDiskutil(hdd), 'hdd');
  assert.equal(parseDiskutil('nothing'), 'unknown');
});

test('决策：auto 遇 hdd / mixed 关分块，手动设置优先', () => {
  assert.equal(resolveChunking('ssd', 'auto'), true);
  assert.equal(resolveChunking('unknown', 'auto'), true, '探测不到就保持现状（允许分块）');
  assert.equal(resolveChunking('hdd', 'auto'), false);
  assert.equal(resolveChunking('mixed', 'auto'), false);
  assert.equal(resolveChunking('hdd', 'ssd'), true, '手动强制开启');
  assert.equal(resolveChunking('ssd', 'hdd'), false, '手动强制关闭');
  assert.equal(resolveChunking('unknown', undefined), true);
});

test('sysfs 全盘扫描：忽略 loop / dm，汇总成三态', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fly-disk-'));
  const make = (name, rotational) => {
    if (rotational === undefined) {
      mkdirSync(path.join(root, name), { recursive: true });
      return;
    }
    mkdirSync(path.join(root, name, 'queue'), { recursive: true });
    writeFileSync(path.join(root, name, 'queue', 'rotational'), rotational);
  };
  try {
    make('loop0', '0');
    make('dm-0', '1');
    make('sda', '1');
    const oneHdd = await scanRotationalAll(root);
    assert.equal(oneHdd.kind, 'hdd', 'loop / dm 不该把结果带偏');
    assert.equal(oneHdd.source, 'sysfs (all disks)');

    make('nvme0n1', '0');
    assert.equal((await scanRotationalAll(root)).kind, 'mixed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
