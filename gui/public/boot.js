// FOWT guard: apply an explicit light/dark choice before first paint. "system" leaves the
// attribute unset so color-scheme:light-dark follows the OS. Mirrors App.tsx.
(function () {
  try {
    var t = localStorage.getItem("epx-theme");
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (t === "light" || t === "dark") {
      document.documentElement.setAttribute("data-theme", t);
      if (meta) meta.setAttribute("content", t);
    } else if (meta) {
      meta.setAttribute("content", "light dark");
    }
  } catch (e) {}
  // FOUT guard: set <html lang> before first paint so :lang() font stacks apply immediately.
  // Mirrors detectInitial() + LOCALES in src/i18n/shared.ts.
  var langMap = { en: "en", de: "de", fr: "fr", ko: "ko", zh: "zh-CN", "zh-TW": "zh-TW", ru: "ru", ja: "ja", tr: "tr", vi: "vi" };
  langMap.pt = "pt-BR";
  var stored = null;
  try {
    stored = localStorage.getItem("epx-lang");
  } catch (e) {
    stored = null; // storage blocked: fall back to navigator.language below
  }
  var locale = stored && Object.prototype.hasOwnProperty.call(langMap, stored) ? stored : null;
  if (!locale) {
    var nav = (navigator.language || "en").toLowerCase();
    if (nav.indexOf("zh") === 0) {
      locale = /tw|hk|mo|hant/.test(nav) ? "zh-TW" : "zh";
    } else {
      locale = ["de", "fr", "ko", "ru", "ja", "tr", "vi", "pt"].filter(function (c) { return nav.indexOf(c) === 0; })[0] || "en";
    }
  }
  document.documentElement.lang = langMap[locale];
})();
