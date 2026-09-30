// Автопилот по расписанию — отдельная функция, пока НЕ подключённая к
// интерфейсу попапа (см. «Идеи на будущее» в CLAUDE.md). Свой файл, свои
// обработчики chrome.runtime.onMessage/chrome.alarms/chrome.notifications —
// ничего в background.js (state, runLoop) не трогает и не может на него
// повлиять. Пока попап не начнёт слать сообщения "autopilot-*" (этого ещё
// нет), весь этот файл просто ничего не делает.
//
// Решено Иваном 30.09.2026 (после трёх скриншотов реального МЭШ):
// - отдельной кнопки «Начать урок»/«Завершить урок» в МЭШ нет;
// - автопилот должен открывать материал урока в начале, закрывать вкладку
//   в конце, и только потом проверять/ставить ДЗ как сейчас («полный цикл»);
// - план, включённый накануне, НЕ должен запускаться сам по будильнику —
//   нужен подтверждающий клик утром.
//
// Этап 1 (этот файл, сейчас): «вооружить» день (дата + список уроков) →
// будильник за CONFIRM_BEFORE_MIN минут до первого урока → уведомление с
// кнопками «Да, начинаем» / «Отменить на сегодня». Дальше пока не идём:
// открытие материала урока и закрытие вкладки нужно кодировать по реальному
// DOM, а его мы ещё не видели (не подтверждено: открывает ли «Просмотреть»
// НОВУЮ вкладку или меняет адрес в той же) — писать это вслепую нельзя, та
// же дисциплина, что и с журналом. Как только это подтвердится — здесь же
// появится планирование per-урочных будильников (открыть материал / закрыть
// вкладку / проверить ДЗ) поверх уже готового подтверждения.

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

function cancelPlan() {
  return new Promise((resolve) => {
    chrome.alarms.clear(AUTOPILOT_ALARM, () => {
      chrome.notifications.clear(AUTOPILOT_NOTIF, () => {
        chrome.storage.local.remove("autopilotPlan", resolve);
      });
    });
  });
}

async function handleConfirmAlarm() {
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
  if (msg.type === "autopilot-arm") {
    armPlan(msg.date, msg.lessons).then((plan) => sendResponse({ ok: true, plan }));
    return true;
  }
  if (msg.type === "autopilot-status") {
    getPlan().then((plan) => sendResponse({ ok: true, plan }));
    return true;
  }
  if (msg.type === "autopilot-cancel") {
    cancelPlan().then(() => sendResponse({ ok: true }));
    return true;
  }
});
