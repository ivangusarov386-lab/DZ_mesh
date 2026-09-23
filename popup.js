const WEEKDAYS = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];

let lessons = [];          // все уроки недели (из schedule_items) — только
                            // те, где в расписании ДВЕ кнопки: «К журналу»
                            // и «К уроку» (см. правило в inject.js)
// ВАЖНО: зелёный «домик» в расписании (эндпоинт homework_presence) означает,
// что на этот урок НУЖНО СДАТЬ ранее заданное ДЗ, а не то, что ДЗ выдано
// НА этом уроке. Поэтому по нему нельзя решать, у каких уроков «нет ДЗ» —
// раньше из-за этого уроки без выданного ДЗ ошибочно считались «задано» и
// пропускались. Теперь проверяются ВСЕ уроки дня: расширение открывает
// каждый урок и смотрит на саму страницу («Домашнее задание отсутствует»
// или уже есть задание). Итог по каждому уроку хранится здесь.
let results = {};          // id урока -> "created" | "exists" | "failed"
let selectedDate = null;   // [Y,M,D]
let activeTabId = null;
let pollTimer = null;
let ecCount = 0;            // замечено записей "внеурочная" (ВН) — пропущено
let aeCount = 0;            // замечено записей "доп. образование" — пропущено

const daysEl = document.getElementById("days");
const lessonsEl = document.getElementById("lessons");
const statusEl = document.getElementById("status");
const runBtn = document.getElementById("runBtn");
const loadBtn = document.getElementById("loadBtn");

function log(text, replace = false) {
  if (replace) {
    statusEl.textContent = text;
  } else {
    statusEl.textContent += (statusEl.textContent ? "\n" : "") + text;
  }
  statusEl.scrollTop = statusEl.scrollHeight;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// При каждом открытии popup сразу спрашиваем фон: вдруг задача уже идёт
// (или только что завершилась), чтобы не потерять прогресс из виду.
(async function init() {
  const tab = await getActiveTab();
  if (tab) activeTabId = tab.id;

  const status = await chrome.runtime.sendMessage({ type: "get-status" }).catch(() => null);
  if (status && (status.running || (status.total > 0 && status.log && status.log.length))) {
    renderFromStatus(status);
    if (status.running) startPolling();
  }
})();

loadBtn.addEventListener("click", async () => {
  lessons = [];
  results = {};
  ecCount = 0;
  aeCount = 0;
  selectedDate = null;
  daysEl.innerHTML = "";
  lessonsEl.innerHTML = "";
  runBtn.style.display = "none";
  log("Открываю расписание и жду загрузки недели...", true);

  const tab = await getActiveTab();
  if (!tab || !tab.url || !tab.url.includes("school.mos.ru")) {
    log("Откройте вкладку school.mos.ru (кабинет учителя), затем нажмите кнопку ещё раз.", true);
    return;
  }
  activeTabId = tab.id;
  chrome.tabs.sendMessage(tab.id, { type: "reload-schedule" }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "schedule_items") {
    // Защитная проверка (дублирует фильтр в inject.js «на всякий случай»):
    // это должны быть обычные уроки с обеими кнопками «К журналу» и
    // «К уроку» — у таких записей всегда есть group_id и class_unit_id.
    // Если у записи их нет, это не урок в привычном смысле — не берём её
    // в очередь на создание ДЗ.
    lessons = (msg.data || []).filter((l) => l && l.id != null && l.group_id != null && l.class_unit_id != null);
    renderDays();
    updateSummary();
  } else if (msg.type === "ec_schedule_items") {
    // Внеурочная деятельность («ВН») — только «К журналу», без «К уроку».
    // В очередь на ДЗ не идёт, только считаем для честного отчёта.
    ecCount = (msg.data || []).length;
    updateSummary();
  } else if (msg.type === "ae_schedule_items") {
    // Доп. образование / секции («доп») — своя система, без ДЗ в журнале.
    // В очередь на ДЗ не идёт, только считаем для честного отчёта.
    aeCount = (msg.data || []).length;
    updateSummary();
  }
});

function updateSummary() {
  let text = `Загружено уроков за неделю: ${lessons.length} (с кнопками «К журналу» + «К уроку»). Выберите день.`;
  const skipped = [];
  if (ecCount > 0) skipped.push(`внеурочная — ${ecCount}`);
  if (aeCount > 0) skipped.push(`доп. образование — ${aeCount}`);
  if (skipped.length) {
    text += `\nЗамечено и пропущено (без ДЗ в журнале): ${skipped.join(", ")}.`;
  }
  log(text, true);
}

function dateKey(d) {
  return d.join("-");
}

function renderDays() {
  const uniqueDates = [];
  const seen = new Set();
  for (const l of lessons) {
    const key = dateKey(l.date);
    if (!seen.has(key)) {
      seen.add(key);
      uniqueDates.push(l.date);
    }
  }
  uniqueDates.sort((a, b) => dateKey(a).localeCompare(dateKey(b)));

  daysEl.innerHTML = "";
  for (const d of uniqueDates) {
    const [y, m, day] = d;
    const jsDate = new Date(y, m - 1, day);
    const weekday = WEEKDAYS[jsDate.getDay()];
    const btn = document.createElement("button");
    btn.className = "day-btn";
    btn.textContent = `${String(day).padStart(2, "0")}.${String(m).padStart(2, "0")} ${weekday.slice(0, 2)}`;
    btn.title = weekday;
    btn.addEventListener("click", () => {
      selectedDate = d;
      [...daysEl.children].forEach((c) => c.classList.remove("selected"));
      btn.classList.add("selected");
      renderLessons();
    });
    daysEl.appendChild(btn);
  }
}

const RESULT_LABELS = {
  created: ["создано", "status-ok"],
  exists: ["уже было", "status-ok"],
  failed: ["ошибка", "status-missing"],
};

function dayLessons() {
  return lessons
    .filter((l) => dateKey(l.date) === dateKey(selectedDate))
    .sort((a, b) => (a.time[0] * 60 + a.time[1]) - (b.time[0] * 60 + b.time[1]));
}

// Уроки, которые ещё надо проверить: всё, кроме уже проверенных успешно.
function pendingLessons() {
  return dayLessons().filter((l) => results[l.id] !== "created" && results[l.id] !== "exists");
}

function renderLessons() {
  lessonsEl.innerHTML = "";
  for (const l of dayLessons()) {
    const row = document.createElement("div");
    row.className = "lesson-row";
    const time = `${String(l.time[0]).padStart(2, "0")}:${String(l.time[1]).padStart(2, "0")}`;
    const label = document.createElement("span");
    label.textContent = `${time} ${l.group_name}`;
    const status = document.createElement("span");
    const r = RESULT_LABELS[results[l.id]];
    if (r) {
      status.textContent = r[0];
      status.className = r[1];
    } else {
      status.textContent = "проверю";
      status.className = "status-unknown";
    }
    row.appendChild(label);
    row.appendChild(status);
    lessonsEl.appendChild(row);
  }

  const pending = pendingLessons().length;
  if (pending > 0) {
    runBtn.style.display = "block";
    runBtn.textContent = `Проверить и поставить «Не задано.» (${pending} урок(ов))`;
    runBtn.disabled = false;
  } else {
    runBtn.style.display = "none";
  }
}

runBtn.addEventListener("click", async () => {
  const todo = pendingLessons();
  if (todo.length === 0) return;

  runBtn.disabled = true;
  log("", true);

  const resp = await chrome.runtime
    .sendMessage({ type: "start-run", tabId: activeTabId, todo })
    .catch(() => null);

  if (!resp || !resp.ok) {
    log(`Не удалось запустить: ${resp ? resp.reason : "нет ответа от фона"}`, true);
    runBtn.disabled = false;
    return;
  }

  startPolling();
});

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const status = await chrome.runtime.sendMessage({ type: "get-status" }).catch(() => null);
    if (!status) return;
    renderFromStatus(status);
    if (!status.running) {
      clearInterval(pollTimer);
      pollTimer = null;
      if (selectedDate) renderLessons();
      runBtn.disabled = false;
    }
  }, 700);
}

function renderFromStatus(status) {
  Object.assign(results, status.results || {});
  if (selectedDate) renderLessons();
  log((status.log || []).join("\n"), true);
  runBtn.disabled = !!status.running;
}
