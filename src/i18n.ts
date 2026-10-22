import * as vscode from 'vscode';
import { dictionary, getLang, setLang, t } from './i18n-core';
import type { Lang } from './i18n-types';

export { t };
export type { Lang };

/**
 * 跟随 VS Code 的显示语言。`vscode.env.language` 形如 `zh-cn` / `en` / `ja`，
 * 只要以 zh 开头就当简体中文，其余一律走英文（扩展只提供这两套文案）。
 * 没有 env 的环境（单元测试）回退中文，与历史行为一致。
 */
export function detectLang(): Lang {
  const env = vscode.env as { language?: string } | undefined;
  return String(env?.language ?? 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** 在 activate 最早期调用一次，之后所有 t() 都用这个语言。 */
export function initI18n(): Lang {
  const lang = detectLang();
  setLang(lang);
  return lang;
}

export function currentLang(): Lang {
  return getLang();
}

export function isEnglish(): boolean {
  return getLang() === 'en';
}

export function webviewDictionary(): Record<string, string> {
  return dictionary(getLang());
}

export function htmlLang(): string {
  return getLang() === 'en' ? 'en' : 'zh-CN';
}
