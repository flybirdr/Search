/**
 * 输入框历史：搜索词、过滤器、替换词各一条时间线，最近使用的排在最前。
 *
 * 纯逻辑（无 vscode 依赖），宿主与测试共用。数组本身就是存储格式，
 * 直接塞进 memento 即可。
 */

export type InputTarget = 'query' | 'filters' | 'replace';

export interface InputHistory {
  query: string[];
  filters: string[];
  replace: string[];
}

/** 每条时间线保留多少条；再多靠方向键翻也不现实 */
export const INPUT_HISTORY_LIMIT = 50;

export const INPUT_HISTORY_KEY = 'flySearch.inputHistory';

export function emptyInputHistory(): InputHistory {
  return { query: [], filters: [], replace: [] };
}

/** 反序列化：存档可能来自旧版本、被手改过、或干脆是别的类型，一律容错。 */
export function normalizeInputHistory(raw: unknown): InputHistory {
  const out = emptyInputHistory();
  if (!raw || typeof raw !== 'object') {
    return out;
  }
  const record = raw as Record<string, unknown>;
  for (const target of ['query', 'filters', 'replace'] as const) {
    const list = record[target];
    if (!Array.isArray(list)) {
      continue;
    }
    const seen = new Set<string>();
    for (const entry of list) {
      if (typeof entry !== 'string' || entry.length === 0 || seen.has(entry)) {
        continue;
      }
      seen.add(entry);
      out[target].push(entry);
      if (out[target].length >= INPUT_HISTORY_LIMIT) {
        break;
      }
    }
  }
  return out;
}

/**
 * 记一条输入。返回值表示有没有真的改动（调用方据此决定要不要写存档、推前端）。
 *
 * 语义是「最近使用优先」：重复值会被提到最前，不是简单追加——否则同一个
 * 关键词搜十次，按方向键要翻十下才看到别的词。
 *
 * 空串直接忽略：清空输入框不是一次「搜索」，不该占用历史位置。
 */
export function pushInput(
  history: InputHistory,
  target: InputTarget,
  value: string,
  limit = INPUT_HISTORY_LIMIT,
): boolean {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  const list = history[target];
  const at = list.indexOf(value);
  if (at === 0) {
    return false;
  }
  if (at > 0) {
    list.splice(at, 1);
  }
  list.unshift(value);
  if (list.length > limit) {
    list.length = limit;
  }
  return true;
}
