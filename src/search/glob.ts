/**
 * 轻量 glob → 正则。只覆盖文件过滤器需要的那部分语法：
 * `*`、`?`、`**`、`{a,b}`、`\` 转义。
 *
 * 之所以自己实现而不是把模式直接交给 `workspace.findFiles`：
 * findFiles 走 VS Code 内部的 glob 解析，`{a,b}` 里套 `/`、多模式组合这类写法
 * 一旦被解析成非预期结果，表现为“文件莫名少了一大半”，且没有任何错误提示。
 */

function escapeChar(ch: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}

/** 找到与 `{` 配对的 `}`，考虑嵌套。 */
function findClosingBrace(input: string, start: number): number {
  let depth = 0;
  for (let i = start; i < input.length; i += 1) {
    if (input[i] === '{') {
      depth += 1;
    } else if (input[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** 按顶层逗号切分，`{a,b}` 内部的逗号不切。 */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      // 未配对的右括号不参与配对，避免 depth 变负后逗号永远不切
      if (depth > 0) {
        depth -= 1;
      }
    } else if (ch === ',' && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

function translate(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:[^/]*/)*';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '{') {
      const end = findClosingBrace(pattern, i);
      if (end > i) {
        const branches = splitTopLevel(pattern.slice(i + 1, end)).map(translate);
        out += `(?:${branches.join('|')})`;
        i = end + 1;
        continue;
      }
    }
    if (ch === '\\' && i + 1 < pattern.length) {
      out += escapeChar(pattern[i + 1]);
      i += 2;
      continue;
    }
    out += escapeChar(ch);
    i += 1;
  }
  return out;
}

/**
 * 把过滤器转成正则。不含 `/` 的模式（例如 `*.ts`）按“任意目录下”处理，
 * 因为用户写 `*.ts` 时想要的是递归匹配，而不是只看工作区根目录。
 *
 * 性能：模式以星号星号斜杠开头时，译出的正文以「零或多层目录」片段开头，
 * 该片段自己就能吞掉任意前导目录，默认的「行首或斜杠」前缀在语义上冗余，
 * 直接锚定行首（0.1.44）。但锚定写法仍留有平方级回溯：锚定后正则引擎要为
 * 路径的每个斜杠位置枚举「这个位置由片段的第几层吞掉」，实测 8 万条深路径
 * 的过滤循环要花 1 秒以上，且对 V8 的正则调用点特化极其敏感（同样的正则
 * 从常量调用是 14ms，从数组元素 / 闭包参数调用要 1014ms）。
 * 现在改为**无锚定**的段边界起点写法：候选起点从「片段的每种归层方式」
 * 变成「行首或斜杠后」，枚举的位置集合完全相同、语义等价（16 组边界用例
 * 逐条对账过），失败判定线性，且不依赖 V8 的调用点优化（82k 过滤 40ms）。
 * 这里不能把正则字面量写进块注释——含斜杠星号会提前终止注释。
 */
export function globToRegExp(pattern: string): RegExp {
  const trimmed = pattern.trim().replace(/^\.\//, '');
  const body = translate(trimmed);
  const anchored = trimmed.startsWith('/');
  // 「零或多层目录」片段的开头形态；片段本身吞得掉任意前导目录时，
  // 前缀枚举可以完全交给「无锚定 + 行首或斜杠」，见上方性能说明。
  const recursiveDirs = '(?:[^/]*/)*';
  if (!anchored && body.startsWith(recursiveDirs)) {
    return new RegExp(`(?:^|/)${body.slice(recursiveDirs.length)}$`, 'i');
  }
  const redundantPrefix = !anchored && body.startsWith('.*');
  const prefix = anchored || redundantPrefix ? '^' : '(?:^|.*/)';
  return new RegExp(`${prefix}${body}$`, 'i');
}

/** 逗号分隔的过滤器拆成数组；空输入返回空数组。 */
export function splitFilters(input: string | undefined): string[] {
  if (!input) {
    return [];
  }
  // 只按顶层逗号切：`{a,b}` 里的逗号是模式的一部分（默认排除就是
  // 一条含大括号的长模式），按逗号裸切会把一条模式碎成几条残缺模式——
  // 碎片几乎匹配不到东西（语义悄悄失效），还会生成平方级回溯的碎片正则。
  return splitTopLevel(input)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 任一模式命中即可。空模式列表视为“全部通过”。 */
export function matchesAny(patterns: string[], relPath: string): boolean {
  if (patterns.length === 0) {
    return true;
  }
  return patterns.some((pattern) => globToRegExp(pattern).test(relPath));
}

/** findFiles 只接受一个 include，这里挑最简单、最不可能被误解析的那个。 */
export function pickPrimitive(globs: string[]): string {
  if (globs.length !== 1) {
    return '**/*';
  }
  const pattern = globs[0];
  if (pattern.includes('{') || pattern.includes('}')) {
    return '**/*';
  }
  const normalized = pattern.replace(/^\.\//, '');
  if (normalized === '**' || normalized === '**/*' || normalized === '*') {
    return '**/*';
  }
  // 不含斜杠时补上递归前缀，避免 `*.ts` 只匹配根目录
  return normalized.includes('/') ? normalized : `**/${normalized}`;
}
