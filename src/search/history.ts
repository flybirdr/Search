import type { HistoryRecord, ResultGroup, ResultItem, SearchScope } from '../ui/panel';

/** workspaceState 里的键；带版本号，格式变了直接换键。 */
export const HISTORY_KEY = 'flySearch.history.v1';

/**
 * 持久化预算（JSON 字符数，约 1.5 MB）。
 * 结果里最多两万条命中，每条还带一段预览，全部存下来会撑大 workspaceState，
 * 所以超过预算时按「丢最旧记录 → 砍最大分组的一半条目」的顺序收缩。
 */
export const HISTORY_BUDGET = 1_500_000;

/** `[行, 列, 前缀长度, 匹配长度, 结束行, 结束列, 预览]`，全部 1 基。 */
export type StoredItem = [number, number, number, number, number, number, string];

export interface StoredGroup {
  /** 文件名（显示用）。 */
  l: string;
  /** 相对路径（副标题 / 悬浮提示）。 */
  d: string;
  /** 该文件命中数超过单文件上限。 */
  tr?: boolean;
  it: StoredItem[];
}

export interface StoredRecord {
  v: 1;
  id: number;
  /** 查询词。 */
  q: string;
  sc: SearchScope;
  /** scopeLabel / optionsLabel。 */
  sl: string;
  ol: string;
  e: number;
  tr: boolean;
  t: number;
  /** 扫描过的文件总字节数（旧记录没有）。 */
  tb?: number;
  /** 与分组一一对应的文件 uri。 */
  f: string[];
  g: StoredGroup[];
}

export interface StoredHistory {
  v: 1;
  r: StoredRecord[];
}

/** 编码输入：展示用记录 + 分组对应的文件 + 每条命中的结束位置（`[行, 列]`，1 基）。 */
export interface EncodeInput {
  record: HistoryRecord;
  files: string[];
  ends: [number, number][];
}

export interface DecodedRecord {
  record: HistoryRecord;
  files: string[];
  ends: [number, number][];
}

function toStored(input: EncodeInput): StoredRecord {
  const { record } = input;
  const groups: StoredGroup[] = record.groups.map((group) => {
    const items: StoredItem[] = [];
    for (const item of group.items) {
      const end = input.ends[item.id] ?? [item.line, item.column + item.matchLen];
      items.push([
        item.line,
        item.column,
        item.prefix,
        item.matchLen,
        end[0],
        end[1],
        item.preview,
      ]);
    }
    const stored: StoredGroup = { l: group.label, d: group.detail, it: items };
    if (group.truncated) {
      stored.tr = true;
    }
    return stored;
  });

  const stored: StoredRecord = {
    v: 1,
    id: record.id,
    q: record.query,
    sc: record.scope,
    sl: record.scopeLabel,
    ol: record.optionsLabel,
    e: record.elapsed,
    tr: record.truncated,
    t: record.time,
    f: record.groups.map((_, index) => input.files[index] ?? ''),
    g: groups,
  };
  if (typeof record.totalBytes === 'number') {
    stored.tb = record.totalBytes;
  }
  return stored;
}

function byteSize(records: StoredRecord[]): number {
  return JSON.stringify({ v: 1, r: records }).length;
}

/** 把最大分组的条目砍掉一半；没有可砍的返回 false。 */
function shrink(record: StoredRecord): boolean {
  let target = -1;
  let most = 0;
  record.g.forEach((group, index) => {
    if (group.it.length > most) {
      most = group.it.length;
      target = index;
    }
  });
  if (target < 0 || most <= 1) {
    return false;
  }
  const group = record.g[target];
  group.it = group.it.slice(0, Math.ceil(most / 2));
  group.tr = true;
  record.tr = true;
  return true;
}

/**
 * 记录按「最新在前」传入；超预算时先丢最旧的（数组末尾），
 * 只剩一条还超就砍它最大的分组，够用为止。
 */
export function encodeHistory(inputs: EncodeInput[], budget = HISTORY_BUDGET): StoredRecord[] {
  const stored = inputs.map(toStored);
  if (stored.length === 0) {
    return stored;
  }
  while (stored.length > 1 && byteSize(stored) > budget) {
    stored.pop();
  }
  const head = stored[0];
  let guard = 32;
  while (byteSize(stored) > budget && guard > 0 && shrink(head)) {
    guard -= 1;
  }
  return stored;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readItem(raw: unknown): StoredItem | undefined {
  if (!Array.isArray(raw) || raw.length < 7) {
    return undefined;
  }
  const [line, column, prefix, matchLen, endLine, endColumn, preview] = raw;
  if (
    !isFiniteNumber(line) ||
    !isFiniteNumber(column) ||
    !isFiniteNumber(prefix) ||
    !isFiniteNumber(matchLen) ||
    typeof preview !== 'string'
  ) {
    return undefined;
  }
  return [
    line,
    column,
    prefix,
    matchLen,
    isFiniteNumber(endLine) ? endLine : line,
    isFiniteNumber(endColumn) ? endColumn : column + matchLen,
    preview,
  ];
}

const SCOPES: SearchScope[] = ['document', 'open', 'files'];

/**
 * 解码并重建：条目 id 按「分组顺序 + 组内顺序」重新连续编号，
 * 这样恢复出来的记录和当初搜索时一样（id 就是 hits 的下标）。
 * 数据损坏或格式不符时返回空数组，绝不让扩展启动失败。
 */
/**
 * 行式历史文本 → 解码结果。每行一条 encodeHistory 输出的 JSON，坏行跳过
 * 不牵连全场（整份 JSON 一处损坏就全丢的教训）；最多恢复 maxRecords 条
 * （文件序 = 最新在前）。
 */
export function decodeHistoryLines(text: string, maxRecords: number): DecodedRecord[] {
  const decoded: DecodedRecord[] = [];
  for (const line of text.split('\n')) {
    if (decoded.length >= maxRecords) {
      break;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const one = decodeHistory({ v: 1, r: [JSON.parse(trimmed)] });
      decoded.push(...one);
    } catch {
      // 坏行跳过
    }
  }
  return decoded;
}

export function decodeHistory(raw: unknown): DecodedRecord[] {
  if (!raw || typeof raw !== 'object') {
    return [];
  }
  const payload = raw as Partial<StoredHistory>;
  if (payload.v !== 1 || !Array.isArray(payload.r)) {
    return [];
  }

  const decoded: DecodedRecord[] = [];
  for (const rawRecord of payload.r) {
    const record = rawRecord as Partial<StoredRecord>;
    if (!record || typeof record !== 'object' || !Array.isArray(record.g)) {
      continue;
    }
    if (!isFiniteNumber(record.id) || typeof record.q !== 'string') {
      continue;
    }

    const files = Array.isArray(record.f) ? record.f.map((item) => String(item ?? '')) : [];
    const groups: ResultGroup[] = [];
    const ends: [number, number][] = [];
    const items: ResultItem[] = [];

    record.g.forEach((rawGroup, index) => {
      const group = rawGroup as Partial<StoredGroup>;
      if (!group || !Array.isArray(group.it)) {
        return;
      }
      const groupItems: ResultItem[] = [];
      for (const rawItem of group.it) {
        const item = readItem(rawItem);
        if (!item) {
          continue;
        }
        const id = items.length;
        const [line, column, prefix, matchLen, endLine, endColumn, preview] = item;
        const result: ResultItem = { id, line, column, preview, prefix, matchLen };
        items.push(result);
        groupItems.push(result);
        ends.push([endLine, endColumn]);
      }
      if (groupItems.length === 0) {
        return;
      }
      const built: ResultGroup = {
        label: typeof group.l === 'string' && group.l ? group.l : files[index] ?? '',
        detail: typeof group.d === 'string' ? group.d : '',
        items: groupItems,
      };
      if (group.tr) {
        built.truncated = true;
      }
      groups.push(built);
    });

    if (groups.length === 0) {
      continue;
    }

    const built: HistoryRecord = {
      id: record.id,
      query: record.q,
      scope: SCOPES.includes(record.sc as SearchScope) ? (record.sc as SearchScope) : 'document',
      scopeLabel: typeof record.sl === 'string' ? record.sl : '',
      optionsLabel: typeof record.ol === 'string' ? record.ol : '',
      groups,
      total: items.length,
      fileCount: groups.length,
      elapsed: isFiniteNumber(record.e) ? record.e : 0,
      truncated: Boolean(record.tr),
      time: isFiniteNumber(record.t) ? record.t : Date.now(),
    };
    if (isFiniteNumber(record.tb)) {
      built.totalBytes = record.tb;
    }
    decoded.push({ record: built, files, ends });
  }
  return decoded;
}
