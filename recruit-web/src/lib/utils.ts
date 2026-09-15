import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind 类名合并（规范见 recruit-web/AGENTS.md：样式用 Tailwind + cn()） */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * 后端时间为 UTC ISO 字符串（无时区后缀，如 2026-09-15T13:59:35.956），
 * 补 Z 后转本地时区，展示为 MM-DD HH:mm。
 */
export function formatUtcIso(iso: string): string {
  const d = new Date(iso.endsWith('Z') ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
