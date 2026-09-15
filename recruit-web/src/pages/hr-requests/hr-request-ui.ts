import type { HrRequestStatus } from '@/types/hr-request.types';

/** 需求单列表 / 详情共享的展示辅助（纯展示层，不放 types） */

/** 状态徽标配色（对齐原型 chip 体系） */
export const STATUS_CHIP_CLASS: Record<HrRequestStatus, string> = {
  draft: 'bg-warning-tint text-warning',
  pending_approval: 'bg-primary-tint text-primary',
  open: 'bg-success-tint text-success',
  closed: 'bg-divider text-t4',
};

/** 薪资区间文案：15000-25000 → 15K-25K/月 */
export function formatSalary(min: number | null, max: number | null): string {
  const f = (n: number): string =>
    n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}K` : String(n);
  if (min != null && max != null) return `${f(min)}-${f(max)}/月`;
  if (min != null) return `${f(min)} 起/月`;
  if (max != null) return `${f(max)} 以内/月`;
  return '—';
}
