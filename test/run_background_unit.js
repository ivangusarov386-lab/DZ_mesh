// Юнит-тест peekJournals()/runLoop() в background.js БЕЗ браузера —
// подставляем chrome.tabs/chrome.runtime. С 29.09.2026 журнал только
// подсказывает в логе (см. комментарий у peekJournals в background.js —
// статус клетки САМОГО урока оказался ненадёжным, как когда-то зелёный
// домик: он про «сюда попадает срок сдачи», а не «задано здесь»). Смотрим
// статус СЛЕДУЮЩЕЙ после урока клетки (cells идут в порядке документа —
// уже хронологически, следующий элемент массива и есть следующая дата).
// Проверяем: (1) это только сравнение — ВСЕ уроки всё равно открываются и
// идут через check-and-create, независимо от статуса; (2) для урока с
// известной следующей клеткой в лог попадает её статус; (3) для урока,
// который в журнале последний (следующая дата ещё не видна), — отдельное
// сообщение, а не ошибка; (4) сбой открытия журнала не путается с этим.
// Запуск: node run_background_unit.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sentMessages = []; // { tabId, message }
let tabUpdateListeners = [];
let currentGroupId = null;

// Что "видит" журнал каждого класса (group_id -> клетки, В ПОРЯДКЕ ДАТ —
// как их вернул бы readJournalCells() из реальной страницы).
// id 150 — будущая дата этого же класса, которой нет в todo (это нормально:
// у урока 2 это и есть "следующая после него" клетка).
// group_id 303 намеренно не отвечает — проверяем, что это не путают с
// "следующая дата не видна".
const journalData = {
  101: [
    { id: 1, status: "DEFAULT" },  // урок 1 (в todo) — своя клетка теперь не смотрится
    { id: 2, status: "DEFAULT" },  // урок 2 (в todo) — следующая клетка для урока 1
    { id: 150, status: "HOMEWORK" }, // будущий урок (не в todo) — следующая клетка для урока 2
  ],
  202: [
    { id: 3, status: "DEFAULT" }, // урок 3 — единственная и последняя клетка, следующей нет
  ],
};

function resolveResponse(message) {
  if (message.type === "open-journal") {
    currentGroupId = message.groupId;
    return { ok: true };
  }
  if (message.type === "read-journal") {
    if (currentGroupId === 303) return { ok: false, cells: [] }; // журнал "не открылся"
    return { ok: true, cells: journalData[currentGroupId] || [] };
  }
  if (message.type === "open-lesson") {
    return { ok: true };
  }
  if (message.type === "check-and-create") {
    return { ok: true, created: true, verified: true };
  }
  return { ok: true };
}

const chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { chrome.runtime._listener = fn; } },
    lastError: null,
  },
  tabs: {
    sendMessage: (tabId, message, callback) => {
      sentMessages.push({ tabId, message });
      if (message.type === "open-journal" || message.type === "open-lesson") {
        setTimeout(() => tabUpdateListeners.forEach((fn) => fn(tabId, { status: "complete" })), 5);
      }
      const resp = resolveResponse(message);
      setTimeout(() => callback(resp), 10);
    },
    onUpdated: {
      addListener: (fn) => tabUpdateListeners.push(fn),
      removeListener: (fn) => { tabUpdateListeners = tabUpdateListeners.filter((l) => l !== fn); },
    },
  },
};

const sandbox = { chrome, console, setTimeout, clearTimeout, Promise, Date, Math, Set, Map };
vm.createContext(sandbox);
const src = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
vm.runInContext(src, sandbox, { filename: "background.js" });

const todo = [
  { id: 1, group_id: 101, group_name: "5А Математика", date: [2026, 9, 28], time: [9, 0] },
  { id: 2, group_id: 101, group_name: "5А Математика", date: [2026, 9, 28], time: [10, 0] },
  { id: 3, group_id: 202, group_name: "6Б Физика", date: [2026, 9, 28], time: [11, 0] },
  { id: 4, group_id: 303, group_name: "7В Химия", date: [2026, 9, 28], time: [12, 0] },
];

(async () => {
  const resp = await new Promise((resolve) => {
    chrome.runtime._listener(
      { type: "start-run", tabId: 999, todo, day: todo, date: [2026, 9, 28], selected: [1, 2, 3] },
      {},
      resolve
    );
  });
  console.log("start-run ответ:", JSON.stringify(resp));

  // runLoop() работает в фоне (не await'ится в start-run) — ждём, пока
  // status.running не станет false (реальные паузы между уроками — секунды).
  let status;
  for (let i = 0; i < 100; i++) {
    status = await new Promise((resolve) => chrome.runtime._listener({ type: "get-status" }, {}, resolve));
    if (!status.running) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log("\nЛог:");
  status.log.forEach((l) => console.log("  " + l));
  console.log("\nresults:", JSON.stringify(status.results));

  const openLessonIds = sentMessages
    .filter((m) => m.message.type === "open-lesson")
    .map((m) => m.message.id);
  console.log("open-lesson вызван для id:", JSON.stringify(openLessonIds));

  const fullLog = status.log.join("\n");

  const checks = [
    // Главное: журнал только для сравнения — ВСЕ уроки всё равно
    // открываются и проверяются по странице, независимо от его статуса.
    ["урок 1 открывался (open-lesson)", openLessonIds.includes(1)],
    ["урок 1 помечен created (реально проверен по странице)", status.results[1] === "created"],
    ["урок 2 открывался (open-lesson)", openLessonIds.includes(2)],
    ["урок 2 помечен created (реально проверен по странице)", status.results[2] === "created"],
    ["урок 3 (другой класс) тоже открывался и проверен", openLessonIds.includes(3) && status.results[3] === "created"],
    ["урок 4 (журнал не открылся) тоже открывался и проверен", openLessonIds.includes(4) && status.results[4] === "created"],
    // Урок 1: следующая клетка — id 2, статус DEFAULT.
    ["для урока 1 в лог попал статус СЛЕДУЮЩЕЙ клетки (DEFAULT)", fullLog.includes("следующая дата после урока): DEFAULT")],
    // Урок 2: следующая клетка — id 150 (будущий урок не из todo), статус HOMEWORK.
    ["для урока 2 в лог попал статус СЛЕДУЮЩЕЙ клетки (HOMEWORK)", fullLog.includes("следующая дата после урока): HOMEWORK")],
    // Урок 3: последняя клетка в своём журнале — следующей ещё нет.
    ["для урока 3 (последняя клетка) — сообщение «не видна», без ошибки", fullLog.includes("следующая дата после урока пока не видна")],
    // Урок 4: журнал вообще не открылся — отдельное, не спутанное с предыдущим сообщение.
    ["для урока 4 (журнал не открылся) — отдельное сообщение", fullLog.includes("журнал не открылся")],
  ];

  let allOk = true;
  for (const [name, ok] of checks) {
    console.log((ok ? "OK  " : "FAIL") + " — " + name);
    if (!ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
})();
