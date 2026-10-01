// Проверяет, что данные недели (state.weekLessons/ecCount/aeCount) в
// background.js переживают ПЕРЕЗАПУСК SAMOГО service worker'а — не только
// «попап был закрыт в момент загрузки» (это уже проверяет
// run_background_unit.js), а то, что Chrome выгружает service worker из
// памяти сам, безо всякого попапа, примерно после 30с бездействия (обычное
// поведение MV3). Тогда весь файл background.js выполняется заново и
// `state` — обычная переменная — создаётся с нуля. Раньше это была бы та
// же потеря данных, что чинили для случая с попапом, только тут уже
// никакое открытие попапа не поможет, пока сам event не разбудит SW.
//
// Симулируется так: грузим background.js ДВАЖДЫ в ДВА РАЗНЫХ vm-контекста
// (как если бы Chrome дважды «включал» один и тот же service worker), но
// с ОБЩИМ объектом-хранилищем вместо chrome.storage.local — вторая загрузка
// должна увидеть то, что первая сохранила.
// Запуск: node run_schedule_persist_unit.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function makeChromeStub(storageBacking) {
  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { chrome.runtime._listener = fn; } },
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const result = {};
          keys.forEach((k) => { if (k in storageBacking) result[k] = storageBacking[k]; });
          setTimeout(() => cb(result), 0);
        },
        set: (obj, cb) => {
          Object.assign(storageBacking, obj);
          setTimeout(() => cb && cb(), 0);
        },
      },
    },
    tabs: {
      sendMessage: () => {},
      onUpdated: { addListener: () => {}, removeListener: () => {} },
    },
  };
  return chrome;
}

function loadBackground(chrome) {
  const sandbox = { chrome, console, setTimeout, clearTimeout, Promise, Date, Math, Set, Map, importScripts: () => {} };
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  vm.runInContext(src, sandbox, { filename: "background.js" });
  return chrome;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  const storageBacking = {}; // имитирует единый chrome.storage.local на диске

  // --- «Первое включение» SW: приходят данные недели ---
  const chrome1 = makeChromeStub(storageBacking);
  loadBackground(chrome1);
  chrome1.runtime._listener(
    {
      type: "schedule_items",
      data: [{ id: 1, group_id: 10, class_unit_id: 100, group_name: "5А Математика", date: [2026, 10, 1], time: [9, 0] }],
    },
    {},
    () => {}
  );
  chrome1.runtime._listener({ type: "ec_schedule_items", data: [1, 2] }, {}, () => {});
  await sleep(20); // дать chrome.storage.local.set отработать

  // --- «SW перезапустился»: грузим background.js ЗАНОВО, в другом
  // vm-контексте (новый `state` с нуля), но с тем же backing-хранилищем ---
  const chrome2 = makeChromeStub(storageBacking);
  loadBackground(chrome2);
  await sleep(20); // дать chrome.storage.local.get восстановить state

  const status = await new Promise((resolve) => chrome2.runtime._listener({ type: "get-status" }, {}, resolve));
  console.log("Статус после имитации перезапуска service worker'а:", JSON.stringify({
    weekLessons: status.weekLessons.length,
    ecCount: status.ecCount,
  }));

  const checks = [
    ["данные недели пережили перезапуск SW (weekLessons)", status.weekLessons.length === 1 && status.weekLessons[0].id === 1],
    ["данные недели пережили перезапуск SW (ecCount)", status.ecCount === 2],
  ];

  let allOk = true;
  for (const [name, ok] of checks) {
    console.log((ok ? "OK  " : "FAIL") + " — " + name);
    if (!ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
})();
