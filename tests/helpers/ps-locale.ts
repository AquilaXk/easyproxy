/** Run `body` with a non-English locale exported, so a `ps` that ignores it prints a localized lstart. */
export function withKoreanLocale<T>(body: () => T): T {
  const saved = process.env.LC_ALL;
  process.env.LC_ALL = "ko_KR.UTF-8";
  try { return body(); }
  finally { if (saved === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = saved; }
}
