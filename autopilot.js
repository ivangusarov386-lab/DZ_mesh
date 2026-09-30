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
// Этап 1 (этот файл, сейчас): «вооружить» день (дата + список уроков) —
// либо по расписанию (будильник за CONFIRM_BEFORE_MIN минут до первого
// урока → уведомление с кнопками «Да, начинаем» / «Отменить на сегодня»),
// либо вручную из попапа (сразу подтверждён, без будильника и уведомления —
// сам клик по кнопке в попапе и есть подтверждение). Дальше пока не идём:
// открытие материала урока и закрытие вкладки нужно кодировать по реальному
// DOM, а его мы ещё не видели (не подтверждено: открывает ли «Просмотреть»
// НОВУЮ вкладку или меняет адрес в той же) — писать это вслепую нельзя, та
// же дисциплина, что и с журналом. Как только это подтвердится — здесь же
// появится планирование per-урочных будильников (открыть материал / закрыть
// вкладку / проверить ДЗ) поверх уже готового подтверждения — и ручной, и
// авто-режим будут доходить до неё одинаково, через plan.confirmed.

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
    } else {
      sendResponse({ ok: false, reason: "unknown-type" });
    }
  });
  return true;
});
