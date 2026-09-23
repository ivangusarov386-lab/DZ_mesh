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

  if (msg.type === "cancel-run") {
    if (state.running) {
      state.running = false;
      pushLog("Остановлено пользователем.");
    }
    sendResponse({ ok: true });
    return true;
  }
});

async function runLoop() {
  for (state.idx = 0; state.idx < state.todo.length; state.idx++) {
    if (!state.running) break; // отменили

    const lesson = state.todo[state.idx];
    pushLog(`(${state.idx + 1}/${state.total}) Открываю урок: ${lesson.group_name}...`);

    let outcome = await tryCreateHomework(lesson);
    if (outcome.status === "created") {
      pushLog(`✓ ${lesson.group_name}: задание создано`);
    } else if (outcome.status === "exists") {
      pushLog(`— ${lesson.group_name}: уже было задано`);
    } else {
      pushLog(`⚠ ${lesson.group_name}: не удалось (${outcome.reason}), пробую ещё раз...`);
      outcome = await tryCreateHomework(lesson);
      if (outcome.status === "created") {
        pushLog(`✓ ${lesson.group_name}: задание создано (со второй попытки)`);
      } else if (outcome.status === "exists") {
        pushLog(`— ${lesson.group_name}: уже было задано`);
      } else {
        pushLog(`✗ ${lesson.group_name}: НЕ УДАЛОСЬ (${outcome.reason}) — сделайте вручную`);
        // Снимок видимых кнопок на момент сбоя — полезно для диагностики
        // без необходимости открывать консоль разработчика вручную.
        if (outcome.debug) {
          pushLog(`   ${outcome.debug}`);
        }
        state.failed.push(lesson.group_name);
      }
    }

    await sleep(800);
  }

  state.running = false;
  if (state.failed.length > 0) {
    pushLog(`Готово. НЕ создано (нужно вручную): ${state.failed.join(", ")}`);
  } else {
    pushLog(`Готово. Все задания обработаны и проверены.`);
  }
}

async function tryCreateHomework(lesson) {
  await openLessonAndWaitLoad(lesson.id);
  // Страница МЭШ — тяжёлое React-приложение: событие "загрузка вкладки
  // завершена" срабатывает раньше, чем панель "Домашнее задание" реально
  // дорисовывается. Небольшой запас здесь снижает шанс того, что дальнейшие
  // клики в content.js попадут по ещё не отрисованному интерфейсу.
  await sleep(1500);

  const resp = await sendToTab(state.tabId, { type: "check-and-create", text: "Не задано." }).catch(
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
