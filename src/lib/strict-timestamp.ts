import { parseHttpDate } from "./http-date";

const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:[Zz]|([+-])(\d{2}):?(\d{2}))?)?$/;

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return day <= (leap ? 29 : 28);
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) {
    return day <= 30;
  }
  return day <= 31;
}

/**
 * Browser-safe strict timestamp parser for ISO-8601 dates/datetimes and RFC 9110 HTTP-dates.
 * Rejects JSC `Date.parse` heuristics (e.g. `"bad-1"` -> 2001) and calendar overflows
 * (e.g. `"2026-02-30T00:00:00Z"` -> March 2) so malformed inputs fail closed as `NaN`.
 */
export function parseStrictTimestampMs(raw: string): number {
  if (raw === "") return Number.NaN;
  const iso = ISO_TIMESTAMP_RE.exec(raw);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (!isValidCalendarDate(year, month, day)) return Number.NaN;

    if (iso[4] !== undefined) {
      const hour = Number(iso[4]);
      const minute = Number(iso[5]);
      const second = iso[6] !== undefined ? Number(iso[6]) : 0;
      if (hour > 23 || minute > 59 || second > 59) return Number.NaN;
      if (iso[7] !== undefined) {
        const tzHour = Number(iso[8]);
        const tzMinute = Number(iso[9]);
        if (tzHour > 23 || tzMinute > 59) return Number.NaN;
      }
    }

    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }

  const httpDate = parseHttpDate(raw, Date.now());
  return httpDate !== undefined && Number.isFinite(httpDate) ? httpDate : Number.NaN;
}

export function isValidStrictTimestamp(raw: string | null | undefined): raw is string {
  return typeof raw === "string" && Number.isFinite(parseStrictTimestampMs(raw));
}
