// Юнит-тест autopilot.js (этап 1: вооружить день → будильник за 20 минут
// до первого урока → уведомление «Да, начинаем»/«Отменить на сегодня»)
// БЕЗ браузера — подставляем chrome.storage/chrome.alarms/chrome.notifications
// через Node vm, как run_background_unit.js подставляет chrome.tabs.
// Открытие материала урока и закрытие вкладки здесь не тестируются — в
// autopilot.js их пока нет (см. комментарий в начале файла).
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
      get: (keys, cb) => {
        const result = {};
        keys.forEach((k) => { if (k in storage) result[k] = storage[k]; });
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

  let allOk = true;
  for (const [name, ok] of checks) {
    console.log((ok ? "OK  " : "FAIL") + " — " + name);
    if (!ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
})();
