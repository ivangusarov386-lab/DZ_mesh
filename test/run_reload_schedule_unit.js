// Юнит-тест обработчика reload-schedule в content.js БЕЗ браузера (Node vm) —
// проверяет именно баг от 01.10.2026: Иван нажал «Загрузить текущую
// неделю», стоя на СТРАНИЦЕ ОДНОГО УРОКА (.../teacher/account/schedule
// ?scheduleItemId=<id> — то есть после open-lesson, например сразу после
// теста «Открыть материал»), и получил «Загружено уроков за неделю: 0».
// Причина: старая проверка `location.href.startsWith(".../schedule")`
// считала это «уже на странице расписания» (это чистая правда — лишь бы
// нашёлся префикс, а урок как раз .../schedule?scheduleItemId=...) и просто
// делала location.reload() — перезагружая ТОТ ЖЕ урок, а не сетку недели,
// так что schedule_items вообще не перезапрашивался. Исправлено:
// «уже на странице расписания» теперь значит именно пустой путь без
// query-строки — иначе всегда настоящая навигация на чистый адрес сетки.
// Запуск: node run_reload_schedule_unit.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function makeSandbox(initialHref) {
  let currentHref = initialHref;
  let reloaded = false;
  let navigatedTo = null;
  const locationObj = {
    get href() { return currentHref; },
    set href(v) { navigatedTo = v; currentHref = v; },
    reload: () => { reloaded = true; },
  };
  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { chrome.runtime._listener = fn; } },
    },
    storage: {
      local: { get: (defaults, cb) => cb({ ...defaults, enabled: true }) },
      onChanged: { addListener: () => {} },
    },
  };
  const sandbox = {
    chrome, console, setTimeout, clearTimeout, Promise, URL,
    location: locationObj,
    window: { addEventListener: () => {} },
    document: { body: null },
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  vm.runInContext(src, sandbox, { filename: "content.js" });
  return {
    sendReload: () => new Promise((resolve) => chrome.runtime._listener({ type: "reload-schedule" }, {}, resolve)),
    wasReloaded: () => reloaded,
    navigatedTo: () => navigatedTo,
  };
}

const CASES = [
  [
    "уже на чистой сетке недели → просто reload()",
    "https://school.mos.ru/teacher/account/schedule",
    { reload: true, navigate: null },
  ],
  [
    "на странице ОДНОГО урока (после open-lesson) → настоящая навигация на сетку, а не reload того же урока",
    "https://school.mos.ru/teacher/account/schedule?scheduleItemId=625305037",
    { reload: false, navigate: "https://school.mos.ru/teacher/account/schedule" },
  ],
  [
    "на странице журнала (после open-journal) → навигация на сетку, как и раньше",
    "https://school.mos.ru/teacher/study-process/journal/my/12765238",
    { reload: false, navigate: "https://school.mos.ru/teacher/account/schedule" },
  ],
];

(async () => {
  const checks = [];
  for (const [name, href, expected] of CASES) {
    const s = makeSandbox(href);
    await s.sendReload();
    const ok = s.wasReloaded() === expected.reload && s.navigatedTo() === expected.navigate;
    checks.push([name, ok, { reloaded: s.wasReloaded(), navigatedTo: s.navigatedTo() }]);
  }

  let allOk = true;
  for (const [name, ok, actual] of checks) {
    console.log((ok ? "OK  " : "FAIL") + " — " + name + (ok ? "" : " — " + JSON.stringify(actual)));
    if (!ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
})();
