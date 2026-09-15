import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind 类名合并（规范见 recruit-web/AGENTS.md：样式用 Tailwind + cn()） */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
