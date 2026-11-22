import { expect, test } from "bun:test";
import { DICTS, type Locale } from "../src/i18n/catalogs";
import { ko as koCatalog } from "../src/i18n/ko";
import { LAB_CATALOG_OVERRIDES, labSupplement } from "../src/i18n/lab-translations";
import { preloadLocaleCatalog } from "../src/i18n/runtime-catalogs";

const NON_ENGLISH: Locale[] = ["de", "fr", "ja", "ko", "ru", "tr", "zh"];

test("Compatibility Lab catalog overrides cover the translated overlay namespace", () => {
  const englishKeys = Object.keys(DICTS.en)
    .filter(key => key.startsWith("lab.") && !key.startsWith("lab.production."))
    .sort();
  for (const locale of Object.keys(LAB_CATALOG_OVERRIDES) as Locale[]) {
    expect(Object.keys(LAB_CATALOG_OVERRIDES[locale]).sort()).toEqual(englishKeys);
  }
});

test("Compatibility Lab ships localized core copy for every non-English locale", () => {
  for (const locale of NON_ENGLISH) {
    expect(DICTS[locale]["lab.title"]).not.toBe(DICTS.en["lab.title"]);
    expect(DICTS[locale]["lab.loadMore"]).not.toBe(DICTS.en["lab.loadMore"]);
    expect(DICTS[locale]["lab.detailClose"]).not.toBe(DICTS.en["lab.detailClose"]);
    expect(DICTS[locale]["lab.detailEvents"]).not.toBe("Contributing events");
    expect(labSupplement(locale, "artifact.present")).toBeTruthy();
    expect(labSupplement(locale, "selectVerdict", { subject: "subject-a" })).toContain("subject-a");
  }
});

test("Korean base catalog and runtime chunk loader serve localized Compatibility Lab strings", async () => {
  expect(koCatalog["lab.title"]).toBe("호환성 랩");
  expect(koCatalog["lab.verdict.VERIFIED"]).toBe("검증됨");
  const runtimeKo = await preloadLocaleCatalog("ko");
  expect(runtimeKo["lab.title"]).toBe("호환성 랩");
  expect(runtimeKo["lab.detailClose"]).toBe("닫기");
});
