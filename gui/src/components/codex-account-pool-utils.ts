import {
  formatCreditDate as formatCreditDateIntl,
  formatCreditDateTime as formatCreditDateTimeIntl,
} from "../intl-formatters";

export function formatCreditDate(iso: string, locale?: string): string {
  return formatCreditDateIntl(iso, locale);
}

export function formatCreditDateTime(iso: string, locale?: string): string {
  return formatCreditDateTimeIntl(iso, locale);
}

export function daysUntil(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, Math.ceil((ms - Date.now()) / 86_400_000));
}
