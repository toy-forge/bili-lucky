import type { UserStats } from './bilibili';

export interface CountRange { min?: number; max?: number }
export interface DrawRules { requireFollower: boolean; following?: CountRange; followers?: CountRange; dynamics?: CountRange }

export function parseRange(min: string, max: string, label: string): CountRange {
  const parse = (value: string) => {
    if (!value.trim()) return undefined;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label}请输入大于或等于 0 的整数`);
    return number;
  };
  const range = { min: parse(min), max: parse(max) };
  if (range.min === undefined && range.max === undefined) throw new Error(`请为${label}填写至少一个上下限，或关闭筛选`);
  if (range.min !== undefined && range.max !== undefined && range.min > range.max) throw new Error(`${label}下限不能超过上限`);
  return range;
}

export function rejectionReason(stats: UserStats, rules: DrawRules): string | undefined {
  for (const [key, label] of [['following', '关注数量'], ['followers', '粉丝数量'], ['dynamics', '动态数量']] as const) {
    const range = rules[key];
    if (!range) continue;
    const count = stats[key];
    if (count === undefined) throw new Error(`无法获取${label}，抽奖已暂停，请稍后重试`);
    if ((range.min !== undefined && count < range.min) || (range.max !== undefined && count > range.max)) return `${label} ${count} 不符合条件`;
  }
  return undefined;
}
