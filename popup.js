const WEEKDAYS = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];

let lessons = [];          // все уроки недели (из schedule_items)
let presence = {};         // id урока -> есть ли уже дз (true/false)
let selectedDate = null;   // [Y,M,D]
let activeTabId = null;
let pollTimer = null;

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
  presence = {};
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
    lessons = msg.data || [];
    renderDays();
    log(`Загружено уроков за неделю: ${lessons.length}. Выберите день.`, true);
  } else if (msg.type === "homework_presence") {
    for (const row of msg.data || []) {
      presence[row.lesson_schedule_item_id] = row.is_homework_exist;
    }
    if (selectedDate) renderLessons();
  }
});

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

function renderLessons() {
  const dayLessons = lessons
    .filter((l) => dateKey(l.date) === dateKey(selectedDate))
    .sort((a, b) => (a.time[0] * 60 + a.time[1]) - (b.time[0] * 60 + b.time[1]));

  lessonsEl.innerHTML = "";
  let missingCount = 0;

  for (const l of dayLessons) {
    const hasHw = presence[l.id];
    const row = document.createElement("div");
    row.className = "lesson-row";
    const time = `${String(l.time[0]).padStart(2, "0")}:${String(l.time[1]).padStart(2, "0")}`;
    const label = document.createElement("span");
    label.textContent = `${time} ${l.group_name}`;
    const status = document.createElement("span");
    if (hasHw === true) {
      status.textContent = "задано";
      status.className = "status-ok";
    } else if (hasHw === false) {
      status.textContent = "нет ДЗ";
      status.className = "status-missing";
      missingCount++;
    } else {
      status.textContent = "?";
    }
    row.appendChild(label);
    row.appendChild(status);
    lessonsEl.appendChild(row);
  }

  if (missingCount > 0) {
    runBtn.style.display = "block";
    runBtn.textContent = `Создать «Не задано.» (${missingCount} урок(ов))`;
    runBtn.disabled = false;
  } else {
    runBtn.style.display = "none";
  }
}

runBtn.addEventListener("click", async () => {
  const todo = lessons.filter(
    (l) => dateKey(l.date) === dateKey(selectedDate) && presence[l.id] === false
  );
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
      // обновляем статусы уроков дня по факту завершения
      for (const l of status.todo) {
        if (!status.failed.includes(l.group_name)) presence[l.id] = true;
      }
      if (selectedDate) renderLessons();
      runBtn.disabled = false;
    }
  }, 700);
}

function renderFromStatus(status) {
  log((status.log || []).join("\n"), true);
  runBtn.disabled = !!status.running;
}
