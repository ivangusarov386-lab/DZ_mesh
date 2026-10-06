const WEEKDAYS_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

let lessons = [];          // все уроки недели (из schedule_items) — только
                            // те, где в расписании ДВЕ кнопки: «К журналу»
                            // и «К уроку» (см. правило в inject.js)
// ВАЖНО: зелёный «домик» в расписании (эндпоинт homework_presence) означает,
// что на этот урок НУЖНО СДАТЬ ранее заданное ДЗ, а не то, что ДЗ выдано
// НА этом уроке. Поэтому по нему нельзя решать, у каких уроков «нет ДЗ».
// Проверяются уроки, отмеченные галочкой: расширение открывает каждый урок
// и смотрит на саму страницу. Итог по каждому уроку хранится здесь.
let results = {};          // id урока -> "created" | "exists" | "failed"
let excluded = new Set();  // id уроков, с которых сняли галочку
let selectedDate = null;   // [Y,M,D]
let activeTabId = null;
let pollTimer = null;
let running = false;
let stopping = false;
let ecCount = 0;            // замечено записей "внеурочная" (ВН) — пропущено
let aeCount = 0;            // замечено записей "доп. образование" — пропущено
let extensionEnabled = true; // переключатель вверху попапа — полностью гасит расширение

const daysEl = document.getElementById("days");
const lessonsEl = document.getElementById("lessons");
const statusEl = document.getElementById("status");
const runBtn = document.getElementById("runBtn");
const stopBtn = document.getElementById("stopBtn");
const loadBtn = document.getElementById("loadBtn");
const selectAllEl = document.getElementById("selectAll");
const enabledToggle = document.getElementById("enabledToggle");
const disabledNotice = document.getElementById("disabledNotice");
const autopilotBox = document.getElementById("autopilotBox");
const apManualToggle = document.getElementById("apManualToggle");
const apStartBtn = document.getElementById("apStartBtn");
const apStatusEl = document.getElementById("apStatus");
const apCancelEl = document.getElementById("apCancel");
const apOpenMaterialBtn = document.getElementById("apOpenMaterialBtn");
const apCloseMaterialBtn = document.getElementById("apCloseMaterialBtn");
const apMaterialStatusEl = document.getElementById("apMaterialStatus");
const apLaunchScenarioBtn = document.getElementById("apLaunchScenarioBtn");
const apCloseScenarioBtn = document.getElementById("apCloseScenarioBtn");
const apScenarioStatusEl = document.getElementById("apScenarioStatus");

// Выключатель вверху попапа: полностью гасит активность content.js на
// странице МЭШ. Добавлен, потому что параллельно стоит ещё одно расширение
// для МЭШ, и они могут конфликтовать (оба лезут в одну страницу). По
// умолчанию включено — ничего не меняется в поведении, пока сам не выключишь.
chrome.storage.local.get({ enabled: true }, (data) => {
  extensionEnabled = data.enabled;
  enabledToggle.checked = extensionEnabled;
  applyEnabledState();
});

enabledToggle.addEventListener("change", async () => {
  extensionEnabled = enabledToggle.checked;
  chrome.storage.local.set({ enabled: extensionEnabled });
  applyEnabledState();
  if (!extensionEnabled && running) {
    await chrome.runtime.sendMessage({ type: "cancel-run" }).catch(() => {});
  }
});

function applyEnabledState() {
  disabledNotice.style.display = extensionEnabled ? "none" : "block";
  loadBtn.disabled = !extensionEnabled;
  if (!extensionEnabled) {
    runBtn.style.display = "none";
    stopBtn.style.display = "none";
  } else if (selectedDate) {
    updateButtons();
  }
  updateAutopilotVisibility();
}

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

// При каждом открытии popup спрашиваем фон: вдруг задача уже идёт (или была
// остановлена), чтобы показать тот же день, те же галочки и прогресс.
(async function init() {
  const tab = await getActiveTab();
  if (tab) activeTabId = tab.id;

  const status = await chrome.runtime.sendMessage({ type: "get-status" }).catch(() => null);
  if (!status) return;

  // Данные недели (schedule_items) теперь хранятся в фоне независимо от
  // того, был ли запуск — восстанавливаем их в любом случае. Раньше это
  // приходило только живым сообщением, пока попап открыт, и если попап
  // закрылся ровно в момент загрузки (бывает — Chrome закрывает попап от
  // любой потери фокуса), данные терялись насовсем, помогала только
  // повторная перезагрузка страницы наудачу. Жалоба Ивана 30.09.2026:
  // «Загрузить текущую неделю» срабатывает не всегда.
  if (status.weekLessons && status.weekLessons.length) {
    lessons = status.weekLessons;
    ecCount = status.ecCount || 0;
    aeCount = status.aeCount || 0;
  }

  if (status.day && status.day.length) {
    selectedDate = status.date;
    const selectedIds = new Set((status.selected || []).map(String));
    excluded = new Set(status.day.filter((l) => !selectedIds.has(String(l.id))).map((l) => l.id));
    Object.assign(results, status.results || {});
    if (lessons.length === 0) lessons = status.day; // запасной вариант, если weekLessons почему-то пусты
  }

  if (lessons.length) {
    renderDays();
    updateSummary();
  }
  if (status.running || (status.log && status.log.length)) {
    renderFromStatus(status);
    if (status.running) startPolling();
  }
})();

loadBtn.addEventListener("click", async () => {
  if (running || !extensionEnabled) return;
  lessons = [];
  results = {};
  excluded = new Set();
  ecCount = 0;
  aeCount = 0;
  selectedDate = null;
  daysEl.innerHTML = "";
  lessonsEl.innerHTML = "";
  selectAllEl.style.display = "none";
  runBtn.style.display = "none";
  log("Открываю расписание и жду загрузки недели...", true);
  chrome.runtime.sendMessage({ type: "reset-results" }).catch(() => {});

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
    // Защитная проверка: у обычных уроков с кнопками «К журналу» и
    // «К уроку» всегда есть group_id и class_unit_id.
    lessons = (msg.data || []).filter((l) => l && l.id != null && l.group_id != null && l.class_unit_id != null);
    renderDays();
    updateSummary();
  } else if (msg.type === "ec_schedule_items") {
    ecCount = (msg.data || []).length;
    updateSummary();
  } else if (msg.type === "ae_schedule_items") {
    aeCount = (msg.data || []).length;
    updateSummary();
  }
});

function updateSummary() {
  if (running) return;
  let text = `Загружено уроков за неделю: ${lessons.length} (с кнопками «К журналу» + «К уроку»). Выберите день.`;
  const skipped = [];
  if (ecCount > 0) skipped.push(`внеурочная — ${ecCount}`);
  if (aeCount > 0) skipped.push(`доп. образование — ${aeCount}`);
  if (skipped.length) {
    text += `\nЗамечено и пропущено (без ДЗ в журнале): ${skipped.join(", ")}.`;
  }
  log(text, true);
}

// ---------------------------------------------------------------------------
// Дни недели
// ---------------------------------------------------------------------------

function dateKey(d) {
  return d.join("-");
}

// Число для сортировки: 2026-09-28 -> 20260928. Раньше даты сравнивались
// как строки ("2026-10-1" < "2026-9-28"), и октябрь вставал перед сентябрём.
function dateNum(d) {
  return d[0] * 10000 + d[1] * 100 + d[2];
}

function renderDays() {
  const byKey = new Map();
  for (const l of lessons) byKey.set(dateKey(l.date), l.date);
  const dates = [...byKey.values()].sort((a, b) => dateNum(a) - dateNum(b));

  const now = new Date();
  const todayNum = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();

  daysEl.innerHTML = "";
  daysEl.style.gridTemplateColumns = `repeat(${Math.max(dates.length, 1)}, 1fr)`;
  for (const d of dates) {
    const [y, m, day] = d;
    const wd = WEEKDAYS_SHORT[new Date(y, m - 1, day).getDay()];
    const btn = document.createElement("button");
    btn.className = "day-btn";
    if (dateNum(d) === todayNum) btn.classList.add("today");
    if (selectedDate && dateKey(selectedDate) === dateKey(d)) btn.classList.add("selected");
    btn.innerHTML = `<span class="wd"></span><span class="dt"></span>`;
    btn.querySelector(".wd").textContent = wd;
    btn.querySelector(".dt").textContent = `${String(day).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
    btn.title = dateNum(d) === todayNum ? "Сегодня" : "";
    btn.disabled = running;
    btn.addEventListener("click", () => {
      if (running) return;
      selectedDate = d;
      [...daysEl.children].forEach((c) => c.classList.remove("selected"));
      btn.classList.add("selected");
      renderLessons();
    });
    daysEl.appendChild(btn);
  }
  if (selectedDate) renderLessons();
}

// ---------------------------------------------------------------------------
// Уроки выбранного дня (с галочками)
// ---------------------------------------------------------------------------

const RESULT_LABELS = {
  created: ["создано", "status-ok"],
  exists: ["уже было", "status-ok"],
  failed: ["ошибка", "status-missing"],
};

function dayLessons() {
  if (!selectedDate) return [];
  return lessons
    .filter((l) => dateKey(l.date) === dateKey(selectedDate))
    .sort((a, b) => (a.time[0] * 60 + a.time[1]) - (b.time[0] * 60 + b.time[1]));
}

// Что ещё надо проверить: отмеченные галочкой и ещё не проверенные успешно.
function pendingLessons() {
  return dayLessons().filter(
    (l) => !excluded.has(l.id) && results[l.id] !== "created" && results[l.id] !== "exists"
  );
}

function renderLessons() {
  lessonsEl.innerHTML = "";
  const list = dayLessons();
  for (const l of list) {
    const row = document.createElement("label");
    row.className = "lesson-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !excluded.has(l.id);
    cb.disabled = running;
    cb.addEventListener("change", () => {
      if (cb.checked) excluded.delete(l.id);
      else excluded.add(l.id);
      renderLessons();
    });

    const time = `${String(l.time[0]).padStart(2, "0")}:${String(l.time[1]).padStart(2, "0")}`;
    const label = document.createElement("span");
    label.className = "lesson-name";
    label.textContent = `${time} ${l.group_name}`;

    const status = document.createElement("span");
    const r = RESULT_LABELS[results[l.id]];
    if (r) {
      status.textContent = r[0];
      status.className = "lesson-status " + r[1];
    } else {
      status.textContent = excluded.has(l.id) ? "пропущу" : "проверю";
      status.className = "lesson-status status-unknown";
    }

    if (excluded.has(l.id)) row.classList.add("off");
    row.appendChild(cb);
    row.appendChild(label);
    row.appendChild(status);
    lessonsEl.appendChild(row);
  }

  selectAllEl.style.display = list.length ? "inline-block" : "none";
  updateButtons();
}

// «Выбрать все / снять все»
selectAllEl.addEventListener("click", (e) => {
  e.preventDefault();
  if (running) return;
  const list = dayLessons();
  const allOn = list.every((l) => !excluded.has(l.id));
  for (const l of list) {
    if (allOn) excluded.add(l.id);
    else excluded.delete(l.id);
  }
  renderLessons();
});

function updateButtons() {
  updateAutopilotVisibility();
  if (!extensionEnabled) {
    runBtn.style.display = "none";
    stopBtn.style.display = "none";
    return;
  }
  const list = dayLessons();
  const allOn = list.length > 0 && list.every((l) => !excluded.has(l.id));
  selectAllEl.textContent = allOn ? "Снять все" : "Выбрать все";
  selectAllEl.classList.toggle("disabled", running);

  if (running) {
    runBtn.style.display = "none";
    stopBtn.style.display = "block";
    stopBtn.disabled = stopping;
    stopBtn.textContent = stopping ? "Останавливаю после текущего урока…" : "Стоп";
    return;
  }
  stopBtn.style.display = "none";

  const pending = pendingLessons().length;
  if (!selectedDate || pending === 0) {
    runBtn.style.display = "none";
    return;
  }
  // Если по этому дню уже что-то проверено — это продолжение.
  const started = list.some((l) => results[l.id]);
  runBtn.style.display = "block";
  runBtn.disabled = false;
  runBtn.textContent = started
    ? `Продолжить (${pending} урок(ов))`
    : `Проверить и поставить «Не задано.» (${pending} урок(ов))`;
}

// ---------------------------------------------------------------------------
// Запуск / стоп
// ---------------------------------------------------------------------------

runBtn.addEventListener("click", async () => {
  const todo = pendingLessons();
  if (todo.length === 0) return;

  runBtn.disabled = true;
  const day = dayLessons();
  const resp = await chrome.runtime
    .sendMessage({
      type: "start-run",
      tabId: activeTabId,
      todo,
      // Чтобы после закрытия/открытия попапа показать тот же день и галочки.
      day,
      date: selectedDate,
      selected: day.filter((l) => !excluded.has(l.id)).map((l) => l.id),
    })
    .catch(() => null);

  if (!resp || !resp.ok) {
    log(`Не удалось запустить: ${resp ? resp.reason : "нет ответа от фона"}`, true);
    runBtn.disabled = false;
    return;
  }
  running = true;
  stopping = false;
  renderDays();
  startPolling();
});

stopBtn.addEventListener("click", async () => {
  stopping = true;
  updateButtons();
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
    }
  }, 700);
}

function renderFromStatus(status) {
  const wasRunning = running;
  running = !!status.running;
  stopping = !!status.stopRequested;
  Object.assign(results, status.results || {});
  log((status.log || []).join("\n"), true);
  if (wasRunning !== running) renderDays(); // включить/выключить дни и галочки
  else if (selectedDate) renderLessons();
  else updateButtons();
}

// ---------------------------------------------------------------------------
// Автопилот (в разработке, см. «Идеи на будущее» в CLAUDE.md) — пока только
// «вооружает» и подтверждает план (autopilot.js), сам ещё не открывает уроки.
// Тумблер «Ручной»: сразу подтверждает (для тестов, не ждать будильник) —
// «Авто»: обычный autopilot-arm, ждём реальный будильник/уведомление.
// ---------------------------------------------------------------------------

function updateAutopilotVisibility() {
  autopilotBox.style.display = extensionEnabled && selectedDate ? "block" : "none";
  updateApButtonLabel();
}

// Раньше кнопка называлась «Начать автопилот сейчас» — Иван нажал, статус
// внизу обновился правильно, но название звучало так, будто что-то должно
// произойти на странице, и он решил, что кнопка не сработала. Открытие
// урока — это ещё не реализовано (см. «Идеи на будущее», этап 3), поэтому
// название честно говорит «тест», а не «начать».
function updateApButtonLabel() {
  apStartBtn.textContent = apManualToggle.checked
    ? "Подтвердить план (тест)"
    : "Вооружить на этот день (тест)";
}
apManualToggle.addEventListener("change", updateApButtonLabel);

function formatApDate(d) {
  return `${String(d[2]).padStart(2, "0")}.${String(d[1]).padStart(2, "0")}`;
}

function renderAutopilotStatus(plan) {
  if (!plan) {
    apStatusEl.textContent = "";
    apCancelEl.style.display = "none";
    return;
  }
  const n = plan.lessons.length;
  if (plan.confirmed) {
    apStatusEl.textContent = `✓ Тест прошёл: план на ${formatApDate(plan.date)} (${n} урок(ов)) подтверждён${
      plan.manual ? " вручную" : ""
    }. Урок(и) при этом НЕ открывались и ДЗ не создавалось — этого шага пока нет.`;
  } else {
    apStatusEl.textContent = `✓ Вооружён на ${formatApDate(plan.date)} — ${n} урок(ов). Жду будильника (за 20 мин до первого урока) и подтверждения в уведомлении.`;
  }
  apCancelEl.style.display = "inline-block";
}

async function refreshAutopilotStatus() {
  const resp = await chrome.runtime.sendMessage({ type: "autopilot-status" }).catch(() => null);
  if (resp && resp.ok) renderAutopilotStatus(resp.plan);
}

apStartBtn.addEventListener("click", async () => {
  const day = dayLessons();
  const chosen = day.filter((l) => !excluded.has(l.id));
  if (chosen.length === 0) {
    apStatusEl.textContent = "Нет выбранных уроков — отметьте хотя бы один галочкой выше.";
    return;
  }
  apStartBtn.disabled = true;
  const manual = apManualToggle.checked;
  const type = manual ? "autopilot-manual-start" : "autopilot-arm";
  const resp = await chrome.runtime
    .sendMessage({ type, date: selectedDate, lessons: chosen })
    .catch(() => null);
  apStartBtn.disabled = false;
  if (!resp || !resp.ok) {
    apStatusEl.textContent = "Не удалось: " + (resp ? resp.reason : "нет ответа от фона");
    return;
  }
  renderAutopilotStatus(resp.plan);
});

apCancelEl.addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.runtime.sendMessage({ type: "autopilot-cancel" }).catch(() => {});
  renderAutopilotStatus(null);
});

// Тест этапа 3 (открытие материала урока) — работает на первом отмеченном
// галочкой уроке выбранного дня. Какая именно вкладка открыта, помнит
// autopilot.js (materialTabs) — попап специально ничего сам не запоминает,
// см. комментарий у apCloseMaterialBtn ниже.
apOpenMaterialBtn.addEventListener("click", async () => {
  const day = dayLessons();
  const chosen = day.filter((l) => !excluded.has(l.id));
  if (chosen.length === 0) {
    apMaterialStatusEl.textContent = "Нет выбранных уроков — отметьте хотя бы один галочкой выше.";
    return;
  }
  const lesson = chosen[0];
  apOpenMaterialBtn.disabled = true;
  apMaterialStatusEl.textContent = `Открываю урок «${lesson.group_name}»...`;
  const resp = await chrome.runtime
    .sendMessage({ type: "autopilot-open-material", tabId: activeTabId, lessonId: lesson.id })
    .catch(() => null);
  apOpenMaterialBtn.disabled = false;
  if (!resp || !resp.ok) {
    apMaterialStatusEl.textContent = "Не удалось: " + (resp ? resp.reason : "нет ответа от фона");
    return;
  }
  if (!resp.opened) {
    apMaterialStatusEl.textContent =
      resp.reason === "no-material"
        ? `У урока «${lesson.group_name}» нет прикреплённого материала — открывать нечего. (диагностика: таких кнопок в коде страницы — ${resp.rawFound ?? "?"})`
        : resp.reason === "multiple-materials"
        ? `У урока «${lesson.group_name}» несколько материалов — пока не знаю, какой открыть, пропустил.`
        : "Материал не открылся.";
    return;
  }
  apMaterialStatusEl.textContent = `✓ Материал урока «${lesson.group_name}» открыт в новой вкладке.`;
});

// Специально закрывает ВСЁ, что сейчас отслеживает фон, а не «запомненный»
// в попапе id урока — попап Chrome может закрыть в любой момент (например,
// от потери фокуса), и такая память тогда пропадает. Живой баг 30.09.2026:
// Иван открыл материал («Открыть» сработало), а «Закрыть» не реагировало —
// почти наверняка именно поэтому.
apCloseMaterialBtn.addEventListener("click", async () => {
  apCloseMaterialBtn.disabled = true;
  apMaterialStatusEl.textContent = "Закрываю...";
  const resp = await chrome.runtime.sendMessage({ type: "autopilot-close-material" }).catch(() => null);
  apCloseMaterialBtn.disabled = false;
  if (!resp || !resp.ok) {
    apMaterialStatusEl.textContent = "Не удалось закрыть: " + (resp ? resp.reason : "нет ответа от фона");
    return;
  }
  apMaterialStatusEl.textContent =
    resp.closedCount > 0
      ? `✓ Закрыто вкладок: ${resp.closedCount}.`
      : "Открытых вкладок с материалом сейчас нет.";
});

// Тест сценария урока («начать урок») — см. AUTOPILOT.md. Та же схема, что
// и у материала выше: берёт первый отмеченный галочкой урок, не помнит id
// урока между «Запустить» и «Закрыть» (см. комментарий у apCloseMaterialBtn).
apLaunchScenarioBtn.addEventListener("click", async () => {
  const day = dayLessons();
  const chosen = day.filter((l) => !excluded.has(l.id));
  if (chosen.length === 0) {
    apScenarioStatusEl.textContent = "Нет выбранных уроков — отметьте хотя бы один галочкой выше.";
    return;
  }
  const lesson = chosen[0];
  apLaunchScenarioBtn.disabled = true;
  apScenarioStatusEl.textContent = `Открываю урок «${lesson.group_name}»...`;
  const resp = await chrome.runtime
    .sendMessage({ type: "autopilot-launch-scenario", tabId: activeTabId, lessonId: lesson.id })
    .catch(() => null);
  apLaunchScenarioBtn.disabled = false;
  if (!resp || !resp.ok) {
    apScenarioStatusEl.textContent =
      resp && resp.reason === "no-scenario"
        ? `У урока «${lesson.group_name}» нет материала в «Материалах к уроку» — запускать нечего.`
        : "Не удалось: " + (resp ? resp.reason : "нет ответа от фона");
    return;
  }
  apScenarioStatusEl.textContent = `✓ Урок запущен в новой вкладке (в фоне) — через «${resp.action}».`;
});

apCloseScenarioBtn.addEventListener("click", async () => {
  apCloseScenarioBtn.disabled = true;
  apScenarioStatusEl.textContent = "Закрываю...";
  const resp = await chrome.runtime.sendMessage({ type: "autopilot-close-scenario" }).catch(() => null);
  apCloseScenarioBtn.disabled = false;
  if (!resp || !resp.ok) {
    apScenarioStatusEl.textContent = "Не удалось закрыть: " + (resp ? resp.reason : "нет ответа от фона");
    return;
  }
  apScenarioStatusEl.textContent =
    resp.closedCount > 0
      ? `✓ Закрыто вкладок: ${resp.closedCount}.`
      : "Открытых вкладок со сценарием сейчас нет.";
});

refreshAutopilotStatus();
setInterval(refreshAutopilotStatus, 2000);
