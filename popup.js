const WEEKDAYS = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];

let lessons = [];          // уроки загруженной недели (или одного дня при
                            // восстановлении после переоткрытия попапа) —
                            // только те, где в расписании ДВЕ кнопки: «К
                            // журналу» и «К уроку» (см. правило в inject.js)
// ВАЖНО: зелёный «домик» в расписании (эндпоинт homework_presence) означает,
// что на этот урок НУЖНО СДАТЬ ранее заданное ДЗ, а не то, что ДЗ выдано
// НА этом уроке. Поэтому расширение не опирается на него, а открывает
// каждый урок и смотрит на саму страницу. Итог по каждому уроку — здесь.
let results = {};          // id урока -> "created" | "exists" | "failed"
let selectedDate = null;   // [Y,M,D]
let checked = new Set();   // id уроков, отмеченных галочкой для запуска
let activeTabId = null;
let pollTimer = null;
let running = false;
let stopRequestedLocally = false; // нажали «Стоп», ждём, пока фон доведёт урок до конца
let ecCount = 0;            // замечено записей "внеурочная" (ВН) — пропущено
let aeCount = 0;            // замечено записей "доп. образование" — пропущено

const daysEl = document.getElementById("days");
const lessonsEl = document.getElementById("lessons");
const statusEl = document.getElementById("status");
const runBtn = document.getElementById("runBtn");
const stopBtn = document.getElementById("stopBtn");
const loadBtn = document.getElementById("loadBtn");
const selectAllEl = document.getElementById("selectAll");

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

function dateKey(d) {
  return d.join("-");
}

function isToday(d) {
  const t = new Date();
  return d[0] === t.getFullYear() && d[1] === t.getMonth() + 1 && d[2] === t.getDate();
}

// При каждом открытии popup сразу спрашиваем фон: вдруг задача уже идёт
// (или только что завершилась), а заодно восстанавливаем последний
// выбранный день и отметки галочками — фон хранит их между открытиями
// попапа (см. state.day/date/selected в background.js).
(async function init() {
  const tab = await getActiveTab();
  if (tab) activeTabId = tab.id;

  const status = await chrome.runtime.sendMessage({ type: "get-status" }).catch(() => null);
  if (!status) return;

  results = { ...status.results };
  running = !!status.running;

  if (status.day && status.day.length) {
    lessons = status.day;
    selectedDate = status.date;
    checked = new Set(status.selected || []);
    renderDays();
    renderLessons();
  }

  if (status.running || (status.total > 0 && status.log && status.log.length)) {
    log((status.log || []).join("\n"), true);
    if (status.running) startPolling();
  }
})();

loadBtn.addEventListener("click", async () => {
  if (running) return;
  await chrome.runtime.sendMessage({ type: "reset-results" }).catch(() => {});
  lessons = [];
  results = {};
  checked = new Set();
  ecCount = 0;
  aeCount = 0;
  selectedDate = null;
  daysEl.innerHTML = "";
  lessonsEl.innerHTML = "";
  runBtn.style.display = "none";
  stopBtn.style.display = "none";
  selectAllEl.style.display = "none";
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
    lessons = (msg.data || []).filter((l) => l && l.id != null && l.group_id != null && l.class_unit_id != null);
    selectedDate = null;
    daysEl.innerHTML = "";
    lessonsEl.innerHTML = "";
    runBtn.style.display = "none";
    stopBtn.style.display = "none";
    selectAllEl.style.display = "none";
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

  daysEl.style.gridTemplateColumns = `repeat(${Math.max(uniqueDates.length, 1)}, 1fr)`;
  daysEl.innerHTML = "";
  for (const d of uniqueDates) {
    const [y, m, day] = d;
    const jsDate = new Date(y, m - 1, day);
    const weekday = WEEKDAYS[jsDate.getDay()];
    const btn = document.createElement("button");
    btn.className = "day-btn";
    if (isToday(d)) btn.classList.add("today");
    if (selectedDate && dateKey(d) === dateKey(selectedDate)) btn.classList.add("selected");
    btn.disabled = running;
    btn.title = weekday;
    btn.innerHTML =
      `<span class="wd">${weekday.slice(0, 2)}</span>` +
      `<span class="dt">${String(day).padStart(2, "0")}.${String(m).padStart(2, "0")}</span>`;
    btn.addEventListener("click", () => {
      if (running) return;
      selectedDate = d;
      // Новый день — по умолчанию отмечены все уроки, которые ещё можно
      // отметить (без результата или с «ошибкой»). Если день совпадает с
      // тем, что фон уже хранил (см. init), сюда мы не попадаем — там
      // отметки уже восстановлены из status.selected.
      checked = new Set(selectableLessons().map((l) => l.id));
      renderDays();
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

// Уроки, которые ещё можно отметить галочкой: без результата или с
// «ошибкой» (готовые — «создано»/«уже было» — трогать незачем).
function selectableLessons() {
  return dayLessons().filter((l) => results[l.id] !== "created" && results[l.id] !== "exists");
}

function renderLessons() {
  lessonsEl.innerHTML = "";
  for (const l of dayLessons()) {
    // <label>, а не <div>: клик в любом месте строки переключает чекбокс
    // без лишнего JS — это и даёт «cursor: pointer» на всю строку из CSS.
    const row = document.createElement("label");
    row.className = "lesson-row";
    const time = `${String(l.time[0]).padStart(2, "0")}:${String(l.time[1]).padStart(2, "0")}`;
    const r = RESULT_LABELS[results[l.id]];
    const selectable = !r || results[l.id] === "failed";

    if (selectable) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = checked.has(l.id);
      cb.disabled = running;
      if (!cb.checked) row.classList.add("off");
      cb.addEventListener("change", () => {
        if (cb.checked) checked.add(l.id);
        else checked.delete(l.id);
        row.classList.toggle("off", !cb.checked);
        updateRunControls();
      });
      row.appendChild(cb);
    } else {
      row.style.paddingLeft = "22px"; // выравниваем текст по чекбоксам других строк
    }

    const label = document.createElement("span");
    label.className = "lesson-name";
    label.textContent = `${time} ${l.group_name}`;
    const status = document.createElement("span");
    status.className = "lesson-status" + (r ? " " + r[1] : "");
    status.textContent = r ? r[0] : "";
    row.appendChild(label);
    row.appendChild(status);
    lessonsEl.appendChild(row);
  }

  updateRunControls();
}

function updateRunControls() {
  const selectable = selectableLessons();
  const anyChecked = selectable.some((l) => checked.has(l.id));

  if (running) {
    selectAllEl.style.display = "none";
  } else if (selectable.length > 0) {
    selectAllEl.style.display = "inline";
    selectAllEl.textContent = anyChecked ? "Снять все" : "Выбрать все";
  } else {
    selectAllEl.style.display = "none";
  }

  const toRun = selectable.filter((l) => checked.has(l.id)).length;
  if (running) {
    runBtn.style.display = "block";
    runBtn.disabled = true;
    runBtn.textContent = "Проверяю...";
    stopBtn.style.display = "block";
    stopBtn.disabled = stopRequestedLocally;
    stopBtn.textContent = stopRequestedLocally ? "Останавливаю..." : "Стоп";
  } else if (toRun > 0) {
    runBtn.style.display = "block";
    runBtn.disabled = false;
    runBtn.textContent = `Проверить (${toRun})`;
    stopBtn.style.display = "none";
  } else {
    runBtn.style.display = "none";
    stopBtn.style.display = "none";
  }
}

selectAllEl.addEventListener("click", (e) => {
  e.preventDefault();
  if (running) return;
  const selectable = selectableLessons();
  const anyChecked = selectable.some((l) => checked.has(l.id));
  for (const l of selectable) {
    if (anyChecked) checked.delete(l.id);
    else checked.add(l.id);
  }
  renderLessons();
});

runBtn.addEventListener("click", async () => {
  const todo = selectableLessons().filter((l) => checked.has(l.id));
  if (todo.length === 0) return;

  running = true;
  stopRequestedLocally = false;
  renderDays();
  renderLessons();
  log("", true);

  const resp = await chrome.runtime
    .sendMessage({
      type: "start-run",
      tabId: activeTabId,
      todo,
      day: dayLessons(),
      date: selectedDate,
      selected: [...checked],
    })
    .catch(() => null);

  if (!resp || !resp.ok) {
    log(`Не удалось запустить: ${resp ? resp.reason : "нет ответа от фона"}`, true);
    running = false;
    renderDays();
    renderLessons();
    return;
  }

  startPolling();
});

stopBtn.addEventListener("click", async () => {
  stopRequestedLocally = true;
  updateRunControls();
  await chrome.runtime.sendMessage({ type: "cancel-run" }).catch(() => {});
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
      stopRequestedLocally = false;
      renderDays();
    }
  }, 700);
}

function renderFromStatus(status) {
  results = { ...status.results };
  running = !!status.running;
  if (selectedDate) renderLessons(); // тоже обновляет runBtn/stopBtn/selectAll
  log((status.log || []).join("\n"), true);
}
