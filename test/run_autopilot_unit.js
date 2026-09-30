// Юнит-тест autopilot.js БЕЗ браузера — подставляет chrome.storage/
// chrome.alarms/chrome.notifications/chrome.tabs через Node vm, как
// run_background_unit.js подставляет chrome.tabs для background.js.
// Покрывает: вооружить день → будильник за 20 минут до первого урока →
// уведомление «Да, начинаем»/«Отменить на сегодня» (этап 1); ручной запуск
// и отказ команд при выключенном расширении (этап 2); открытие материала
// урока (нет материала / один / несколько) и закрытие открытой вкладки
// (этап 3) — content.js здесь не участвует, chrome.tabs.sendMessage сам
// отвечает тем, что задано в openMaterialResponse, имитируя ответ страницы.
// Запуск: node run_autopilot_unit.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let storage = {};
let alarms = {}; // name -> alarmInfo
let clearedAlarms = [];
let createdNotifications = []; // { id, options }
let clearedNotifications = [];

const chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { chrome.runtime._listener = fn; } },
  },
  storage: {
    local: {
      // Реальный chrome.storage.local.get принимает либо массив ключей
      // (вернёт только то, что есть в storage), либо объект умолчаний
      // (вернёт значение по умолчанию для отсутствующих ключей) — autopilot.js
      // использует оба варианта (getPlan() — массив, isExtensionEnabled() —
      // объект умолчаний), стаб должен понимать оба.
      get: (keysOrDefaults, cb) => {
        const result = {};
        if (Array.isArray(keysOrDefaults)) {
          keysOrDefaults.forEach((k) => { if (k in storage) result[k] = storage[k]; });
        } else {
          Object.keys(keysOrDefaults).forEach((k) => {
            result[k] = k in storage ? storage[k] : keysOrDefaults[k];
          });
        }
        setTimeout(() => cb(result), 0);
      },
      set: (obj, cb) => {
        Object.assign(storage, obj);
        setTimeout(() => cb && cb(), 0);
      },
      remove: (key, cb) => {
        delete storage[key];
        setTimeout(() => cb && cb(), 0);
      },
    },
  },
  alarms: {
    create: (name, info) => { alarms[name] = info; },
    clear: (name, cb) => {
      clearedAlarms.push(name);
      delete alarms[name];
      setTimeout(() => cb && cb(true), 0);
    },
    onAlarm: { addListener: (fn) => { chrome.alarms._listener = fn; } },
  },
  notifications: {
    create: (id, options) => { createdNotifications.push({ id, options }); },
    clear: (id, cb) => {
      clearedNotifications.push(id);
      setTimeout(() => cb && cb(true), 0);
    },
    onButtonClicked: { addListener: (fn) => { chrome.notifications._listener = fn; } },
  },
};

// --- chrome.tabs: для openMaterialForLesson()/closeMaterialForLesson() ---
// open-lesson ведёт себя как в run_background_unit.js (onUpdated "complete").
// open-material отвечает тем, что задано в openMaterialResponse (меняется
// по ходу теста) — если opened:true, вдобавок «создаём» новую вкладку
// (onCreated), как это по-настоящему делает клик «Просмотреть».
let tabUpdateListeners = [];
let tabCreatedListeners = [];
let removedTabIds = [];
let openMaterialResponse = { ok: true, opened: false, reason: "no-material" };
let skipTabCreation = false; // для проверки «вкладка не появилась»
let nextCreatedTabId = 1000;

chrome.tabs = {
  sendMessage: (tabId, message, callback) => {
    if (message.type === "open-lesson") {
      setTimeout(() => tabUpdateListeners.forEach((fn) => fn(tabId, { status: "complete" })), 5);
      setTimeout(() => callback({ ok: true }), 10);
    } else if (message.type === "open-material") {
      const resp = openMaterialResponse;
      setTimeout(() => {
        callback(resp);
        if (resp.ok && resp.opened && !skipTabCreation) {
          const newTabId = nextCreatedTabId++;
          setTimeout(() => tabCreatedListeners.forEach((fn) => fn({ id: newTabId, openerTabId: tabId })), 5);
        }
      }, 10);
    } else {
      setTimeout(() => callback({ ok: true }), 10);
    }
  },
  onUpdated: {
    addListener: (fn) => tabUpdateListeners.push(fn),
    removeListener: (fn) => { tabUpdateListeners = tabUpdateListeners.filter((l) => l !== fn); },
  },
  onCreated: {
    addListener: (fn) => tabCreatedListeners.push(fn),
    removeListener: (fn) => { tabCreatedListeners = tabCreatedListeners.filter((l) => l !== fn); },
  },
  remove: (tabId, cb) => {
    removedTabIds.push(tabId);
    setTimeout(() => cb && cb(), 0);
  },
};

const sandbox = { chrome, console, setTimeout, clearTimeout, Promise, Date, Math, Set, Map };
vm.createContext(sandbox);
const src = fs.readFileSync(path.join(__dirname, "..", "autopilot.js"), "utf8");
vm.runInContext(src, sandbox, { filename: "autopilot.js" });

function sendMsg(msg) {
  return new Promise((resolve) => chrome.runtime._listener(msg, {}, resolve));
}

function timeOf(d) {
  return [d.getHours(), d.getMinutes()];
}

(async () => {
  const checks = [];
  const now = new Date();
  const todayArr = [now.getFullYear(), now.getMonth() + 1, now.getDate()];

  // --- Случай 1: обычное вооружение дня, первый урок через 30 минут ---
  const soon1 = new Date(now.getTime() + 30 * 60000);
  const soon2 = new Date(now.getTime() + 75 * 60000);
  const lessons = [
    { id: 1, group_name: "5А Математика", time: timeOf(soon2) },
    { id: 2, group_name: "5А Математика", time: timeOf(soon1) }, // раньше — именно он "первый"
  ];

  const armResp = await sendMsg({ type: "autopilot-arm", date: todayArr, lessons });
  checks.push(["autopilot-arm отвечает ok", armResp && armResp.ok === true]);
  checks.push(["план сохранён с confirmed:false", armResp.plan && armResp.plan.confirmed === false]);

  // armPlan хранит время урока как [h, m] (без секунд) и пересобирает Date
  // из даты + [h, m] — секунды/мс, которые есть у реального soon1.getTime(),
  // при этом теряются. Считаем ожидание так же, через [h, m], а не через
  // полную метку времени, иначе сравнение будет ложно проваливаться на
  // ненулевых секундах текущего момента.
  const soon1Rounded = new Date(soon1.getFullYear(), soon1.getMonth(), soon1.getDate(), soon1.getHours(), soon1.getMinutes(), 0, 0);
  const expectedWhen = soon1Rounded.getTime() - 20 * 60000;
  const actualWhen = alarms["autopilot-confirm"] && alarms["autopilot-confirm"].when;
  checks.push([
    "будильник поставлен на (первый урок − 20 мин)",
    typeof actualWhen === "number" && Math.abs(actualWhen - expectedWhen) < 2000,
  ]);

  // --- Случай 2: будильник сработал вовремя → уведомление с кнопками ---
  await chrome.alarms._listener({ name: "autopilot-confirm" });
  await sleep(20);
  const notif1 = createdNotifications[createdNotifications.length - 1];
  checks.push(["уведомление показано", !!notif1 && notif1.id === "autopilot-confirm-notif"]);
  checks.push(["в уведомлении 2 кнопки", !!notif1 && notif1.options.buttons.length === 2]);
  checks.push(["в тексте упомянуто число уроков", !!notif1 && notif1.options.message.includes("2 урок")]);

  // --- Случай 3: нажали «Да, начинаем» (кнопка 0) → план подтверждён ---
  await chrome.notifications._listener("autopilot-confirm-notif", 0);
  await sleep(20);
  const statusResp1 = await sendMsg({ type: "autopilot-status" });
  checks.push(["после «Да, начинаем» план подтверждён", statusResp1.plan && statusResp1.plan.confirmed === true]);
  checks.push(["уведомление убрано", clearedNotifications.includes("autopilot-confirm-notif")]);

  // --- Случай 4: вооружаем заново и нажимаем «Отменить на сегодня» (кнопка 1) ---
  createdNotifications = [];
  await sendMsg({ type: "autopilot-arm", date: todayArr, lessons });
  await chrome.alarms._listener({ name: "autopilot-confirm" });
  await sleep(20);
  await chrome.notifications._listener("autopilot-confirm-notif", 1);
  await sleep(20);
  const statusResp2 = await sendMsg({ type: "autopilot-status" });
  checks.push(["после «Отменить на сегодня» план снят", statusResp2.plan === null]);

  // --- Случай 5: будильник сработал на план с ДРУГОГО дня (завис) — не показываем уведомление ---
  createdNotifications = [];
  storage.autopilotPlan = {
    dateKey: "2000-01-01",
    date: [2000, 1, 1],
    lessons,
    confirmed: false,
    armedAt: new Date(0).toISOString(),
  };
  await chrome.alarms._listener({ name: "autopilot-confirm" });
  await sleep(20);
  checks.push(["план с чужой датой — уведомление НЕ показано", createdNotifications.length === 0]);
  const statusResp3 = await sendMsg({ type: "autopilot-status" });
  checks.push(["план с чужой датой — снят сам", statusResp3.plan === null]);

  // --- Случай 6: будильник опоздал (первый урок уже начался) — тоже без уведомления ---
  createdNotifications = [];
  const past = new Date(now.getTime() - 5 * 60000);
  await sendMsg({ type: "autopilot-arm", date: todayArr, lessons: [{ id: 9, group_name: "6Б", time: timeOf(past) }] });
  await chrome.alarms._listener({ name: "autopilot-confirm" });
  await sleep(20);
  checks.push(["опоздавший будильник — уведомление НЕ показано", createdNotifications.length === 0]);
  const statusResp4 = await sendMsg({ type: "autopilot-status" });
  checks.push(["опоздавший план — снят как пропущенный", statusResp4.plan === null]);

  // --- Случай 7: ручной запуск (тумблер «Ручной» в попапе) — сразу
  // подтверждён, без будильника и уведомления ---
  const manualResp = await sendMsg({ type: "autopilot-manual-start", date: todayArr, lessons });
  checks.push(["autopilot-manual-start отвечает ok", manualResp && manualResp.ok === true]);
  checks.push(["ручной план сразу confirmed:true", manualResp.plan && manualResp.plan.confirmed === true]);
  checks.push(["ручной план помечен manual:true", manualResp.plan && manualResp.plan.manual === true]);
  checks.push(["ручной запуск не ставит будильник", !alarms["autopilot-confirm"]]);
  checks.push(["ручной запуск не показывает уведомление", createdNotifications.length === 0]);

  // --- Случай 8: расширение выключено целиком — автопилот не принимает
  // новые команды (но статус спросить можно) ---
  storage.enabled = false;
  const armWhileDisabled = await sendMsg({ type: "autopilot-arm", date: todayArr, lessons });
  checks.push(["arm при выключенном расширении — отказ", armWhileDisabled.ok === false && armWhileDisabled.reason === "extension-disabled"]);
  const manualWhileDisabled = await sendMsg({ type: "autopilot-manual-start", date: todayArr, lessons });
  checks.push(["manual-start при выключенном расширении — отказ", manualWhileDisabled.ok === false && manualWhileDisabled.reason === "extension-disabled"]);
  const openMaterialWhileDisabled = await sendMsg({ type: "autopilot-open-material", tabId: 1, lessonId: 1 });
  checks.push(["open-material при выключенном расширении — отказ", openMaterialWhileDisabled.ok === false && openMaterialWhileDisabled.reason === "extension-disabled"]);
  const closeMaterialWhileDisabled = await sendMsg({ type: "autopilot-close-material", lessonId: 1 });
  checks.push(["close-material при выключенном расширении — отказ", closeMaterialWhileDisabled.ok === false && closeMaterialWhileDisabled.reason === "extension-disabled"]);
  const statusWhileDisabled = await sendMsg({ type: "autopilot-status" });
  checks.push(["status при выключенном расширении всё равно отвечает", statusWhileDisabled.ok === true]);
  storage.enabled = true;

  // --- Случай 9: открытие материала урока — материал есть, ровно один ---
  const MESH_TAB_ID = 777;
  openMaterialResponse = { ok: true, opened: true };
  const openResp1 = await sendMsg({ type: "autopilot-open-material", tabId: MESH_TAB_ID, lessonId: 501 });
  checks.push(["материал есть — open-material отвечает ok", openResp1 && openResp1.ok === true]);
  checks.push(["материал есть — opened:true", openResp1 && openResp1.opened === true]);
  checks.push(["материал есть — вернулся id новой вкладки", typeof openResp1.tabId === "number"]);

  // --- Случай 10: у урока нет материала — пропускаем, это не ошибка ---
  openMaterialResponse = { ok: true, opened: false, reason: "no-material" };
  const openResp2 = await sendMsg({ type: "autopilot-open-material", tabId: MESH_TAB_ID, lessonId: 502 });
  checks.push(["материала нет — ok:true, opened:false", openResp2 && openResp2.ok === true && openResp2.opened === false]);
  checks.push(["материала нет — причина no-material", openResp2.reason === "no-material"]);

  // --- Случай 11: у урока несколько материалов — тоже пропускаем ---
  openMaterialResponse = { ok: true, opened: false, reason: "multiple-materials" };
  const openResp3 = await sendMsg({ type: "autopilot-open-material", tabId: MESH_TAB_ID, lessonId: 503 });
  checks.push(["материалов несколько — ok:true, opened:false", openResp3 && openResp3.ok === true && openResp3.opened === false]);
  checks.push(["материалов несколько — причина multiple-materials", openResp3.reason === "multiple-materials"]);

  // --- Случай 12: закрываем вкладку, открытую в случае 9 ---
  const closeResp1 = await sendMsg({ type: "autopilot-close-material", lessonId: 501 });
  checks.push(["закрытие открытой вкладки — closed:true", closeResp1 && closeResp1.ok === true && closeResp1.closed === true]);
  checks.push(["закрытие вкладки — реально вызван chrome.tabs.remove с её id", removedTabIds.includes(openResp1.tabId)]);

  // --- Случай 13: закрыть для урока, для которого вкладку не открывали ---
  const closeResp2 = await sendMsg({ type: "autopilot-close-material", lessonId: 999 });
  checks.push(["закрытие несуществующей вкладки — closed:false, не ошибка", closeResp2 && closeResp2.ok === true && closeResp2.closed === false]);

  let allOk = true;
  for (const [name, ok] of checks) {
    console.log((ok ? "OK  " : "FAIL") + " — " + name);
    if (!ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
})();
