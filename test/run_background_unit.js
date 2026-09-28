// Юнит-тест preCheckJournals()/runLoop() в background.js БЕЗ браузера —
// подставляем chrome.tabs/chrome.runtime и проверяем, что уроки, у которых
// журнал говорит "HOMEWORK", помечаются "exists" и НЕ открываются, а
// остальные идут через обычную check-and-create, как раньше.
// Запуск: node run_background_unit.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sentMessages = []; // { tabId, message }
let tabUpdateListeners = [];
let currentGroupId = null;

// Что "видит" журнал каждого класса (group_id -> клетки).
// group_id 303 намеренно не отвечает — проверяем защиту от того, что урок
// молча пропустят, если журнал вообще не открылся.
const journalData = {
  101: [
    { id: 1, status: "HOMEWORK" }, // урок 1 — уже задано, открывать не должны
    { id: 2, status: "DEFAULT" },  // урок 2 — ещё нет, должны открыть и проверить
  ],
  202: [
    { id: 3, status: "DEFAULT" }, // урок 3 — другой класс, тоже ещё нет
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

  const checks = [
    ["урок 1 помечен exists (из журнала)", status.results[1] === "exists"],
    ["урок 1 НЕ открывался (open-lesson)", !openLessonIds.includes(1)],
    ["урок 2 помечен created (проверен по странице)", status.results[2] === "created"],
    ["урок 2 открывался (open-lesson)", openLessonIds.includes(2)],
    ["урок 3 помечен created (другой класс, тоже проверен)", status.results[3] === "created"],
    ["урок 3 открывался (open-lesson)", openLessonIds.includes(3)],
    ["урок 4 (журнал не открылся) НЕ пропущен молча", status.results[4] !== "exists"],
    ["урок 4 всё равно проверен как обычно", status.results[4] === "created"],
    ["урок 4 открывался (open-lesson)", openLessonIds.includes(4)],
  ];

  let allOk = true;
  for (const [name, ok] of checks) {
    console.log((ok ? "OK  " : "FAIL") + " — " + name);
    if (!ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
})();
