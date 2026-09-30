// Автопилот по расписанию (см. «Идеи на будущее» в CLAUDE.md). Свой файл,
// свои обработчики chrome.runtime.onMessage/chrome.alarms/chrome.notifications —
// ничего в background.js (state, runLoop) не трогает и не может на него
// повлиять.
//
// Решено Иваном 30.09.2026 (после трёх скриншотов реального МЭШ):
// - отдельной кнопки «Начать урок»/«Завершить урок» в МЭШ нет;
// - автопилот должен открывать материал урока в начале, закрывать вкладку
//   в конце, и только потом проверять/ставить ДЗ как сейчас («полный цикл»);
// - план, включённый накануне, НЕ должен запускаться сам по будильнику —
//   нужен подтверждающий клик утром;
// - но для тестов важна возможность запустить процесс вручную, не дожидаясь
//   будильника — попап даёт тумблер «Ручной / Авто» (см. popup.js).
//
// Этап 1: «вооружить» день (дата + список уроков) — либо по расписанию
// (будильник за CONFIRM_BEFORE_MIN минут до первого урока → уведомление с
// кнопками «Да, начинаем» / «Отменить на сегодня»), либо вручную из попапа
// (сразу подтверждён, без будильника и уведомления — сам клик по кнопке в
// попапе и есть подтверждение).
//
// Этап 3 (открытие материала урока — начато 30.09.2026): Иван подтвердил
// через DevTools, что кнопка «...» у карточки материала помечена
// data-test-component="materialCardMenuList-<uuid>" (см. content.js) и что
// клик «Просмотреть» открывает НОВУЮ вкладку (не меняет адрес в текущей).
// openMaterialForLesson()/closeMaterialForLesson() ниже реализуют именно
// это — пока как отдельное, вызываемое вручную из попапа тестовое действие
// («Открыть материал» / «Закрыть вкладку»), НЕ как часть автоматического
// цикла по будильникам — те будильники (открыть материал ровно в начале
// урока, закрыть ровно в конце) ещё не запланированы, это следующий шаг,
// когда ручной тест подтвердит, что открытие/закрытие само по себе работает
// надёжно на живом МЭШ.
//
// У этого файла намеренно СВОИ копии sleep/sendToTab/openLessonAndWaitLoad
// (с префиксом ap*), а не переиспользование одноимённых функций из
// background.js — хотя это один общий service worker (background.js грузит
// этот файл через importScripts, поэтому технически мог бы звать чужие
// функции по имени), но тогда autopilot.js перестал бы быть независимым и
// самотестируемым файлом, как заявлено выше, и стал бы неявно ломаться при
// правках background.js, которые его совершенно не касаются.

const AUTOPILOT_ALARM = "autopilot-confirm";
const AUTOPILOT_NOTIF = "autopilot-confirm-notif";
const CONFIRM_BEFORE_MIN = 20; // будильник — за сколько минут до первого урока
const NOTIF_ICON = "icons/notify-128.png";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function dateKeyOf(d) {
  return `${d[0]}-${pad2(d[1])}-${pad2(d[2])}`;
}

function todayKey() {
  const n = new Date();
  return dateKeyOf([n.getFullYear(), n.getMonth() + 1, n.getDate()]);
}

// Урок с самым ранним временем начала (time: [h, m]).
function earliestLesson(lessons) {
  return lessons.reduce(
    (best, l) => (!best || l.time[0] * 60 + l.time[1] < best.time[0] * 60 + best.time[1] ? l : best),
    null
  );
}

function atTime(dateArr, timeArr) {
  return new Date(dateArr[0], dateArr[1] - 1, dateArr[2], timeArr[0], timeArr[1], 0, 0);
}

function getPlan() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["autopilotPlan"], (r) => resolve(r.autopilotPlan || null));
  });
}

function armPlan(date, lessons) {
  const plan = {
    dateKey: dateKeyOf(date),
    date,
    lessons,
    confirmed: false,
    armedAt: new Date().toISOString(),
  };
  return new Promise((resolve) => {
    chrome.storage.local.set({ autopilotPlan: plan }, () => {
      chrome.alarms.clear(AUTOPILOT_ALARM, () => {
        const first = earliestLesson(lessons);
        if (first) {
          const confirmAt = atTime(date, first.time).getTime() - CONFIRM_BEFORE_MIN * 60000;
          chrome.alarms.create(AUTOPILOT_ALARM, { when: confirmAt });
        }
        resolve(plan);
      });
    });
  });
}

// Ручной запуск из попапа (тумблер «Ручной») — для тестов и для дней, когда
// Иван хочет запустить сам, не дожидаясь будильника. Сразу confirmed: true —
// клик по кнопке в попапе это и есть подтверждение, отдельное уведомление
// не нужно. Никакой будильник не ставится.
function manualStart(date, lessons) {
  const plan = {
    dateKey: dateKeyOf(date),
    date,
    lessons,
    confirmed: true,
    manual: true,
    armedAt: new Date().toISOString(),
  };
  return new Promise((resolve) => {
    chrome.alarms.clear(AUTOPILOT_ALARM, () => {
      chrome.notifications.clear(AUTOPILOT_NOTIF, () => {
        chrome.storage.local.set({ autopilotPlan: plan }, () => resolve(plan));
      });
    });
  });
}

function cancelPlan() {
  return new Promise((resolve) => {
    chrome.alarms.clear(AUTOPILOT_ALARM, () => {
      chrome.notifications.clear(AUTOPILOT_NOTIF, () => {
        chrome.storage.local.remove("autopilotPlan", resolve);
      });
    });
  });
}

// Тот же выключатель, что наверху попапа («Расширение включено») — если
// выключено, автопилот не должен ни показывать уведомление, ни принимать
// новые команды из попапа. try/catch на случай недоступного storage — как
// в content.js, лучше считать включённым, чем сломать всё на ровном месте.
function isExtensionEnabled() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get({ enabled: true }, (data) => resolve(data.enabled !== false));
    } catch (e) {
      resolve(true);
    }
  });
}

async function handleConfirmAlarm() {
  if (!(await isExtensionEnabled())) return; // расширение выключено целиком — как будто автопилота нет

  const plan = await getPlan();
  if (!plan || plan.confirmed) return; // нечего подтверждать

  if (plan.dateKey !== todayKey()) {
    // план остался с другого дня (не подтвердили тогда) — не путать с сегодняшним
    await cancelPlan();
    return;
  }

  const first = earliestLesson(plan.lessons);
  if (first && Date.now() >= atTime(plan.date, first.time).getTime()) {
    // Будильник опоздал (например, ноутбук спал) — первый урок уже начался,
    // открыть материал вовремя не успеваем. Не показываем «начинаем?», как
    // будто ничего не произошло — план считается пропущенным.
    await cancelPlan();
    return;
  }

  chrome.notifications.create(AUTOPILOT_NOTIF, {
    type: "basic",
    iconUrl: NOTIF_ICON,
    title: "Автопилот МЭШ",
    message: `План на сегодня готов — ${plan.lessons.length} урок(ов). Начинаем?`,
    buttons: [{ title: "Да, начинаем" }, { title: "Отменить на сегодня" }],
    requireInteraction: true,
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTOPILOT_ALARM) handleConfirmAlarm();
});

// --- Материал урока: открыть новую вкладку / закрыть её (см. комментарий
// «Этап 3» наверху файла — пока вызывается вручную из попапа для теста) ---

const materialTabs = {}; // lessonId -> id открытой вкладки с материалом (только в памяти, для теста)

function apSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function apSendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(resp);
    });
  });
}

function apOpenLessonAndWaitLoad(tabId, lessonId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    apSendToTab(tabId, { type: "open-lesson", id: lessonId }).catch(() => {});
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 9000);
  });
}

// Открывает страницу урока, нажимает «...» → «Просмотреть» на его материале
// (content.js, open-material) и ловит появившуюся НОВУЮ вкладку по
// openerTabId. Подтверждено Иваном 30.09.2026: открывается именно новая
// вкладка на uchebnik.mos.ru, а не смена адреса в текущей. openerTabId не
// требует разрешения "tabs" или хост-разрешения на uchebnik.mos.ru — в
// отличие от url/title, это не «чувствительное» поле chrome.tabs.Tab.
function openMaterialForLesson(meshTabId, lessonId) {
  return new Promise((resolve) => {
    let settled = false;
    const onCreated = (tab) => {
      if (tab.openerTabId === meshTabId) finish({ ok: true, opened: true, tabId: tab.id });
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onCreated.removeListener(onCreated);
      if (result.tabId != null) materialTabs[lessonId] = result.tabId;
      resolve(result);
    };
    chrome.tabs.onCreated.addListener(onCreated);

    apOpenLessonAndWaitLoad(meshTabId, lessonId)
      .then(() => apSleep(1500)) // дать панели «Материалы к уроку» дорисоваться
      .then(() => apSendToTab(meshTabId, { type: "open-material" }))
      .then((resp) => {
        if (!resp || !resp.ok) {
          finish({ ok: false, reason: resp ? resp.reason : "нет ответа от страницы" });
          return;
        }
        if (!resp.opened) {
          // Материала нет или их несколько — это не ошибка, просто нечего открывать.
          finish({ ok: true, opened: false, reason: resp.reason });
          return;
        }
        // content.js нажал «Просмотреть» — ждём onCreated (таймаут на случай,
        // если по какой-то причине вкладка так и не появится).
        setTimeout(() => finish({ ok: false, reason: "новая вкладка не появилась за 5 секунд" }), 5000);
      })
      .catch(() => finish({ ok: false, reason: "message-failed" }));
  });
}

function closeMaterialForLesson(lessonId) {
  return new Promise((resolve) => {
    const tabId = materialTabs[lessonId];
    if (!tabId) {
      resolve({ ok: true, closed: false, reason: "нет открытой вкладки для этого урока" });
      return;
    }
    chrome.tabs.remove(tabId, () => {
      void chrome.runtime.lastError; // вкладку могли уже закрыть вручную — не ошибка
      delete materialTabs[lessonId];
      resolve({ ok: true, closed: true });
    });
  });
}

// Закрывает ВСЕ сейчас отслеживаемые вкладки с материалами, а не одну
// конкретную. Кнопка «Закрыть» в попапе специально устроена так, чтобы НЕ
// полагаться на память о том, для какого урока открывала — это попапный
// JS-объект, а Chrome закрывает попап от любой потери фокуса, и после
// переоткрытия эта память пропадает. Живой баг 30.09.2026: Иван открыл
// материал («Открыть» сработало), но «Закрыть» не реагировало — почти
// наверняка потому, что попап успел переоткрыться до второго клика.
function closeAllMaterialTabs() {
  const lessonIds = Object.keys(materialTabs);
  if (lessonIds.length === 0) return Promise.resolve({ ok: true, closedCount: 0 });
  return Promise.all(lessonIds.map((id) => closeMaterialForLesson(id))).then((results) => ({
    ok: true,
    closedCount: results.filter((r) => r.closed).length,
  }));
}

chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
  if (notifId !== AUTOPILOT_NOTIF) return;
  chrome.notifications.clear(AUTOPILOT_NOTIF);

  if (btnIdx === 1) {
    await cancelPlan();
    return;
  }

  const plan = await getPlan();
  if (!plan) return;
  plan.confirmed = true;
  chrome.storage.local.set({ autopilotPlan: plan });
  // Дальше — открытие материалов уроков, закрытие вкладок и авто-проверка
  // ДЗ. Не реализовано: см. «Этап 1» в комментарии наверху файла.
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("autopilot-")) return false;

  // autopilot-status разрешаем и при выключенном расширении — попап должен
  // суметь показать «план был, но расширение выключено», а не просто молчать.
  if (msg.type === "autopilot-status") {
    getPlan().then((plan) => sendResponse({ ok: true, plan }));
    return true;
  }

  isExtensionEnabled().then((enabled) => {
    if (!enabled) {
      sendResponse({ ok: false, reason: "extension-disabled" });
      return;
    }
    if (msg.type === "autopilot-arm") {
      armPlan(msg.date, msg.lessons).then((plan) => sendResponse({ ok: true, plan }));
    } else if (msg.type === "autopilot-manual-start") {
      manualStart(msg.date, msg.lessons).then((plan) => sendResponse({ ok: true, plan }));
    } else if (msg.type === "autopilot-cancel") {
      cancelPlan().then(() => sendResponse({ ok: true }));
    } else if (msg.type === "autopilot-open-material") {
      openMaterialForLesson(msg.tabId, msg.lessonId).then((r) => sendResponse(r));
    } else if (msg.type === "autopilot-close-material") {
      // lessonId не передан из попапа (см. комментарий у closeAllMaterialTabs) —
      // но поддерживаем и точечное закрытие по id, если он всё же есть.
      const closer = msg.lessonId != null ? closeMaterialForLesson(msg.lessonId) : closeAllMaterialTabs();
      closer.then((r) => sendResponse(r));
    } else {
      sendResponse({ ok: false, reason: "unknown-type" });
    }
  });
  return true;
});
