// Проверяет, что materialTabs в autopilot.js переживает ПЕРЕЗАПУСК самого
// service worker'а (не только переоткрытие попапа — то уже чинили, но
// Chrome может выгрузить SW из памяти сам, примерно после 30с бездействия,
// обычное поведение MV3). Живой баг 01.10.2026: Иван открыл материал
// урока, кнопка «Закрыть» ничего не нашла — вероятная вторая причина
// (помимо уже исправленной потери apMaterialLessonId в попапе): между
// двумя кликами вполне могли пройти те самые 30+ секунд.
//
// Симулируется так же, как для данных недели (run_schedule_persist_unit.js):
// грузим autopilot.js ДВАЖДЫ в РАЗНЫЕ vm-контексты с ОБЩИМ backing-объектом
// вместо chrome.storage.local — «открываем материал» в первом, «закрываем»
// во втором, который сам никогда не открывал ничего и может узнать про
// открытую вкладку только из storage.
// Запуск: node run_material_persist_unit.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeChromeStub(storageBacking, tabEvents) {
  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { chrome.runtime._listener = fn; } },
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const result = {};
          (Array.isArray(keys) ? keys : Object.keys(keys)).forEach((k) => {
            if (k in storageBacking) result[k] = storageBacking[k];
            else if (!Array.isArray(keys)) result[k] = keys[k];
          });
          setTimeout(() => cb(result), 0);
        },
        set: (obj, cb) => {
          Object.assign(storageBacking, obj);
          setTimeout(() => cb && cb(), 0);
        },
      },
    },
    alarms: { create: () => {}, clear: (name, cb) => setTimeout(() => cb && cb(true), 0), onAlarm: { addListener: () => {} } },
    notifications: { create: () => {}, clear: (id, cb) => setTimeout(() => cb && cb(true), 0), onButtonClicked: { addListener: () => {} } },
    tabs: {
      sendMessage: (tabId, message, callback) => {
        if (message.type === "open-lesson") {
          setTimeout(() => tabEvents.updateListeners.forEach((fn) => fn(tabId, { status: "complete" })), 5);
          setTimeout(() => callback({ ok: true }), 10);
        } else if (message.type === "open-material") {
          setTimeout(() => {
            callback({ ok: true, opened: true });
            const newTabId = tabEvents.nextTabId++;
            setTimeout(() => tabEvents.createdListeners.forEach((fn) => fn({ id: newTabId, openerTabId: tabId })), 5);
          }, 10);
        } else {
          setTimeout(() => callback({ ok: true }), 10);
        }
      },
      onUpdated: {
        addListener: (fn) => tabEvents.updateListeners.push(fn),
        removeListener: (fn) => { tabEvents.updateListeners = tabEvents.updateListeners.filter((l) => l !== fn); },
      },
      onCreated: {
        addListener: (fn) => tabEvents.createdListeners.push(fn),
        removeListener: (fn) => { tabEvents.createdListeners = tabEvents.createdListeners.filter((l) => l !== fn); },
      },
      remove: (tabId, cb) => {
        tabEvents.removed.push(tabId);
        setTimeout(() => cb && cb(), 0);
      },
    },
  };
  return chrome;
}

function loadAutopilot(chrome) {
  const sandbox = { chrome, console, setTimeout, clearTimeout, Promise, Date, Math, Set, Map };
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, "..", "autopilot.js"), "utf8");
  vm.runInContext(src, sandbox, { filename: "autopilot.js" });
  return chrome;
}

function sendMsg(chrome, msg) {
  return new Promise((resolve) => chrome.runtime._listener(msg, {}, resolve));
}

(async () => {
  const storageBacking = {};

  // --- "Первое включение" SW: открываем материал ---
  const tabEvents1 = { updateListeners: [], createdListeners: [], removed: [], nextTabId: 2000 };
  const chrome1 = makeChromeStub(storageBacking, tabEvents1);
  loadAutopilot(chrome1);
  const openResp = await sendMsg(chrome1, { type: "autopilot-open-material", tabId: 500, lessonId: 777 });
  console.log("Открыли материал (первая загрузка):", JSON.stringify(openResp));
  await sleep(20); // дать storage.set отработать

  // --- "SW перезапустился": грузим autopilot.js ЗАНОВО в другом
  // vm-контексте (materialTabs с нуля), с тем же backing-хранилищем ---
  const tabEvents2 = { updateListeners: [], createdListeners: [], removed: [], nextTabId: 3000 };
  const chrome2 = makeChromeStub(storageBacking, tabEvents2);
  loadAutopilot(chrome2);
  await sleep(20); // дать storage.get восстановить materialTabs

  const closeResp = await sendMsg(chrome2, { type: "autopilot-close-material" }); // без lessonId, как шлёт попап
  console.log("Закрыли (вторая загрузка, никогда сама не открывала):", JSON.stringify(closeResp));

  const checks = [
    ["открытие вернуло id вкладки", typeof openResp.tabId === "number"],
    ["закрытие после «перезапуска» нашло и закрыло ровно её", closeResp.closedCount === 1 && tabEvents2.removed.includes(openResp.tabId)],
  ];

  let allOk = true;
  for (const [name, ok] of checks) {
    console.log((ok ? "OK  " : "FAIL") + " — " + name);
    if (!ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
})();
