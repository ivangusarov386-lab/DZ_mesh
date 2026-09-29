// Фоновый процесс (service worker) — работает независимо от всплывающего
// окна. Popup может закрыться в любой момент (Chrome закрывает его при
// потере фокуса, например если кликнуть по вкладке страницы) — раньше вся
// логика жила в popup.js, и из-за этого обработка обрывалась на середине.
// Теперь popup только запускает задачу здесь и может закрываться/открываться
// заново, не мешая работе.

let state = {
  running: false,
  tabId: null,
  todo: [],       // очередь уроков [{id, group_name, ...}]
  idx: 0,
  total: 0,
  failed: [],     // имена классов, которые не удалось обработать
  results: {},    // id урока -> "created" | "exists" | "failed" (копится
                  // между запусками, чтобы «Продолжить» не проверял заново)
  stopRequested: false, // нажали «Стоп» — остановиться после текущего урока
  day: [],        // все уроки выбранного дня — чтобы попап после
  date: null,     // переоткрытия показал тот же день
  selected: [],   // id отмеченных галочкой уроков
  log: [],        // текстовые строки для отображения в popup
};

function pushLog(line) {
  state.log.push(line);
  if (state.log.length > 400) state.log.shift();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "start-run") {
    if (state.running) {
      sendResponse({ ok: false, reason: "already-running" });
      return true;
    }
    state = {
      running: true,
      tabId: msg.tabId,
      todo: msg.todo || [],
      idx: 0,
      total: (msg.todo || []).length,
      failed: [],
      results: { ...state.results },
      stopRequested: false,
      day: msg.day || [],
      date: msg.date || null,
      selected: msg.selected || [],
      log: [],
    };
    pushLog(`Запуск: уроков в очереди — ${state.total}.`);
    runLoop(); // не ждём — работает в фоне
    sendResponse({ ok: true });
    return true;
  }

  // Пошаговый отчёт из content.js: что именно нажато на странице урока.
  // Показываем в логе попапа с отступом под строкой урока.
  if (msg.type === "hw-step") {
    if (state.running) pushLog(`   · ${msg.text}`);
    return false;
  }

  if (msg.type === "get-status") {
    sendResponse({ ...state });
    return true;
  }

  // «Стоп»: не обрываем урок на середине (иначе на странице останется
  // открытая форма), а останавливаемся сразу после текущего урока.
  if (msg.type === "cancel-run") {
    if (state.running && !state.stopRequested) {
      state.stopRequested = true;
      pushLog("Стоп: закончу текущий урок и остановлюсь...");
    }
    sendResponse({ ok: true });
    return true;
  }

  // Загрузили новую неделю — старые итоги больше не нужны.
  if (msg.type === "reset-results") {
    if (!state.running) {
      state.results = {};
      state.day = [];
      state.date = null;
      state.selected = [];
      state.log = [];
    }
    sendResponse({ ok: true });
    return true;
  }
});

async function runLoop() {
  let created = 0;
  let existed = 0;

  await peekJournals(); // только логирует для сравнения, решения не меняет (см. комментарий ниже)

  for (state.idx = 0; state.idx < state.todo.length; state.idx++) {
    if (state.stopRequested) break; // нажали «Стоп»

    const lesson = state.todo[state.idx];

    pushLog(`(${state.idx + 1}/${state.total}) Открываю урок: ${lesson.group_name}...`);

    let outcome = await tryCreateHomework(lesson);
    let second = false;
    if (outcome.status === "error") {
      pushLog(`⚠ ${lesson.group_name}: не удалось (${outcome.reason}), пробую ещё раз...`);
      outcome = await tryCreateHomework(lesson);
      second = true;
    }

    if (outcome.status === "created") {
      created++;
      state.results[lesson.id] = "created";
      pushLog(`✓ ${lesson.group_name}: задание создано${second ? " (со второй попытки)" : ""}`);
    } else if (outcome.status === "exists") {
      existed++;
      state.results[lesson.id] = "exists";
      pushLog(`— ${lesson.group_name}: ДЗ на этом уроке уже выдано, пропускаю`);
    } else {
      state.results[lesson.id] = "failed";
      pushLog(`✗ ${lesson.group_name}: НЕ УДАЛОСЬ (${outcome.reason}) — сделайте вручную`);
      // Снимок экрана (кнопки, открытое окно) на момент сбоя.
      if (outcome.debug) pushLog(`   ${outcome.debug}`);
      state.failed.push(lesson.group_name);
    }

    // Пауза между уроками — как у человека, который переходит к следующему.
    if (state.idx < state.todo.length - 1 && !state.stopRequested) {
      await sleep(1500 + Math.random() * 1500);
    }
  }

  const left = state.todo.length - state.idx;
  state.running = false;
  if (state.stopRequested && left > 0) {
    pushLog(`Остановлено. Создано: ${created}, уже было: ${existed}. Осталось: ${left} — нажмите «Продолжить».`);
    state.stopRequested = false;
    return;
  }
  state.stopRequested = false;
  pushLog(`Готово. Создано: ${created}, уже было: ${existed}.`);
  if (state.failed.length > 0) {
    pushLog(`НЕ создано (нужно вручную): ${state.failed.join(", ")}`);
  }
}

// ВРЕМЕННО ТОЛЬКО ДЛЯ СРАВНЕНИЯ, РЕШЕНИЙ НЕ ПРИНИМАЕТ. 29.09.2026 статус
// HOMEWORK клетки САМОГО урока совпал с уроком, на который Иван вживую видел
// красный домик (т.е. ДЗ туда ещё не поставлено). Похоже, домик/статус
// клетки урока показывает не «задано ИМЕННО на этом уроке», а «сюда попадает
// срок сдачи» (в т.ч. заданного раньше) — ровно та же путаница, что была с
// зелёным домиком в расписании (см. «Факты про МЭШ»). На странице урока это
// решается проверкой даты «Проверить к» СТРОГО ПОЗЖЕ даты урока; в журнале
// эквивалент — смотреть статус СЛЕДУЮЩЕЙ после этого урока клетки (туда
// должен попасть срок сдачи задания, выданного сегодня), а не клетки самого
// урока. cells от readJournalCells() идут в порядке документа слева направо,
// то есть уже в хронологическом порядке — следующая клетка после урока по
// индексу и есть следующая дата, без разбора месяцев/заголовков таблицы.
// Функция пока только пишет в лог для сравнения с тем, что реально покажет
// страница урока — решения не меняет, пока не увидим, что это совпадает.
async function peekJournals() {
  const groupIds = [...new Set(state.todo.map((l) => l.group_id).filter((g) => g != null))];

  for (const groupId of groupIds) {
    if (state.stopRequested) break;
    const lessonsInGroup = state.todo.filter((l) => l.group_id === groupId);
    pushLog(`Смотрю журнал «${lessonsInGroup[0].group_name}» (только для сравнения)...`);

    const cells = await readJournalFor(groupId);
    if (!cells) {
      pushLog(`   журнал не открылся`);
      continue;
    }

    for (const lesson of lessonsInGroup) {
      const idx = cells.findIndex((c) => c.id === lesson.id);
      const next = idx >= 0 ? cells[idx + 1] : null;
      if (!next) {
        pushLog(`   журнал: следующая дата после урока пока не видна — сверю по странице урока`);
      } else {
        pushLog(`   журнал (следующая дата после урока): ${next.status} — сверю по странице урока`);
      }
    }
  }
}

function readJournalFor(groupId) {
  return openJournalAndWaitLoad(groupId)
    .then(() => sendToTab(state.tabId, { type: "read-journal" }))
    .then((resp) => (resp && resp.ok ? resp.cells : null))
    .catch(() => null);
}

function openJournalAndWaitLoad(groupId) {
  return new Promise((resolve) => {
    const tabId = state.tabId;
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    sendToTab(tabId, { type: "open-journal", groupId }).catch(() => {});
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 9000);
  });
}

async function tryCreateHomework(lesson) {
  await openLessonAndWaitLoad(lesson.id);
  // Страница МЭШ — тяжёлое React-приложение: событие "загрузка вкладки
  // завершена" срабатывает раньше, чем панель "Домашнее задание" реально
  // дорисовывается. Небольшой запас здесь снижает шанс того, что дальнейшие
  // клики в content.js попадут по ещё не отрисованному интерфейсу.
  await sleep(1500);

  const resp = await sendToTab(state.tabId, {
    type: "check-and-create",
    text: "Не задано.",
    lessonDate: lesson.date, // [Y, M, D] — чтобы отличить ДЗ «к сдаче» от выданного на уроке
  }).catch(
    () => ({ ok: false, reason: "message-failed" })
  );

  if (resp && resp.ok && resp.created && resp.verified) {
    return { status: "created" };
  }
  if (resp && resp.ok && resp.created && !resp.verified) {
    return { status: "error", reason: "создано, но не подтвердилось на странице" };
  }
  if (resp && resp.ok && !resp.created) {
    return { status: "exists" };
  }
  return {
    status: "error",
    reason: resp ? resp.reason : "нет ответа от страницы",
    debug: resp ? resp.debug : undefined,
  };
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(resp);
      }
    });
  });
}

function openLessonAndWaitLoad(lessonId) {
  return new Promise((resolve) => {
    const tabId = state.tabId;
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    sendToTab(tabId, { type: "open-lesson", id: lessonId }).catch(() => {});
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 9000);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
