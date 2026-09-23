// Выполняется в изолированном мире content script — имеет доступ к chrome.runtime,
// но не имеет прямого доступа к переменным страницы. Получает данные от inject.js
// через postMessage и пересылает их во всплывающее окно расширения. Также по
// команде из фона кликает по интерфейсу так же, как это делал бы человек —
// никаких токенов и паролей это не требует.
//
// КАК УСТРОЕНО СОЗДАНИЕ ДЗ (версия 2 — «по экранам», а не «по шагам»)
// ------------------------------------------------------------------
// Раньше код шёл жёсткой цепочкой «клик → подождать N секунд → клик» и
// считал клик успешным, если нашёл ЛЮБОЙ элемент, в тексте которого есть
// нужные слова. Это ломалось так: у блока «Домашнее задание отсутствует»
// теперь две кнопки — «Без домашнего задания» и «Создать домашнее задание»,
// и их общий контейнер-div тоже «содержит текст» «Создать домашнее задание».
// Контейнер стоит в документе раньше кнопки, поэтому кликали по нему —
// а клик по контейнеру кнопку не нажимает. Экран не менялся, код этого не
// замечал и потом 20 секунд ждал форму → «no-textarea».
//
// Теперь:
//  1. Ищем САМЫЙ ГЛУБОКИЙ элемент с нужным текстом (не контейнер) и
//     кликаем по его кнопке, причём только если она видна, активна и не
//     перекрыта модальным окном (проверка elementFromPoint).
//  2. Работаем циклом «посмотри на экран → выбери действие → нажми →
//     дождись, что экран ИЗМЕНИЛСЯ». Если после нажатия ничего не
//     поменялось — это видно сразу, а не через 20 секунд таймаута.
//  3. Каждый шаг отправляется в лог попапа, так что по логу видно, на каком
//     именно экране всё остановилось.

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== "mesh-hw-ext") return;
  chrome.runtime.sendMessage({ type: msg.type, data: msg.data }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "reload-schedule") {
    if (location.href.startsWith("https://school.mos.ru/teacher/account/schedule")) {
      location.reload();
    } else {
      location.href = "https://school.mos.ru/teacher/account/schedule";
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "open-lesson") {
    location.href = `https://school.mos.ru/teacher/account/schedule?scheduleItemId=${msg.id}`;
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "check-and-create") {
    createHomework(msg.text || "Не задано.")
      .then(sendResponse)
      .catch((e) =>
        sendResponse({ ok: false, reason: "ошибка скрипта: " + (e && e.message), debug: snapshot() })
      );
    return true; // ответ будет отправлен асинхронно
  }
});

// ---------------------------------------------------------------------------
// Основной сценарий
// ---------------------------------------------------------------------------

const CREATE_BTN = "Создать домашнее задание";
const SUBMIT_BTN = "Выдать задание";
const CONFIRM_BTN = "Выдать домашнее задание";

let trace = [];

function step(text) {
  trace.push(text);
  chrome.runtime.sendMessage({ type: "hw-step", text }).catch(() => {});
}

function fail(reason, extra) {
  if (extra) step(extra);
  return { ok: false, reason, debug: snapshot() };
}

async function createHomework(text) {
  trace = [];

  // 1. Ждём, пока правая панель урока реально дорисуется.
  const panel = await waitFor(
    () => hasText("Домашнее задание отсутствует") || hasText("Задание №") || hasText("Домашнее задание создано"),
    12000
  );
  if (!panel) return fail("timeout", "панель «Домашнее задание» не загрузилась");
  if (!hasText("Домашнее задание отсутствует")) {
    return { ok: true, created: false, reason: "already-exists" };
  }

  // 2. Идём по экранам, пока не появится поле описания.
  const field = await reachDescriptionField();
  if (!field.ok) return field.result;

  // 3. Вписываем текст.
  const ta = field.el;
  ta.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, text);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(400);
  if (ta.value !== text) return fail("text-not-set", "текст в поле описания не вписался");
  step(`вписал «${text}»`);

  // 4. «Выдать задание» — ждём, пока кнопка станет активной.
  const submit = await waitForEl(() => findClickable(SUBMIT_BTN), 6000);
  if (!submit) return fail("no-submit-button", `нет активной кнопки «${SUBMIT_BTN}»`);
  step(`нажимаю «${SUBMIT_BTN}»`);
  realClick(submit);

  // 5. Окно подтверждения бывает не всегда — ждём либо его, либо успех.
  const next = await waitForEl(
    () => findClickable(CONFIRM_BTN) || (isSuccess() ? "success" : null),
    7000
  );
  if (!next) return fail("no-confirm-button", `после «${SUBMIT_BTN}» ничего не произошло`);
  if (next !== "success") {
    step(`нажимаю «${CONFIRM_BTN}»`);
    realClick(next);
  }

  // 6. Проверяем, что задание действительно появилось.
  const verified = await waitFor(isSuccess, 8000);
  step(verified ? "задание видно на странице" : "задание не подтвердилось на странице");
  return { ok: true, created: true, verified, debug: verified ? undefined : snapshot() };
}

function isSuccess() {
  return hasText("Домашнее задание создано") || hasText("Задание №1");
}

// Цикл «экран → действие → дождаться изменения экрана».
async function reachDescriptionField(totalTimeout = 40000) {
  const deadline = Date.now() + totalTimeout;
  let lastKey = null;
  let repeats = 0;
  let idleSince = Date.now();

  while (Date.now() < deadline) {
    const field = findDescriptionField();
    if (field) {
      step("форма с описанием открыта");
      return { ok: true, el: field };
    }

    const action = pickAction();
    if (!action) {
      // Незнакомый экран или страница ещё грузится. Даём ей время, но не
      // бесконечно — чтобы в логе было видно, что за экран нас остановил.
      if (Date.now() - idleSince > 8000) {
        return { ok: false, result: fail("unknown-screen", "незнакомый экран — не знаю, что нажать") };
      }
      await sleep(300);
      continue;
    }
    idleSince = Date.now();

    if (action.key === lastKey) {
      repeats++;
    } else {
      lastKey = action.key;
      repeats = 0;
    }
    if (repeats >= 2) {
      return {
        ok: false,
        result: fail("stuck", `нажатие «${action.label}» ничего не меняет (3 раза подряд)`),
      };
    }

    step(repeats ? `повторно нажимаю «${action.label}»` : `нажимаю «${action.label}»`);
    const before = screenSignature();
    realClick(action.el);
    // Ждём, пока экран реально поменяется (или появится поле описания).
    await waitFor(() => findDescriptionField() || screenSignature() !== before, 5000, 150);
    await sleep(500); // даём анимации модалки закончиться
  }
  return { ok: false, result: fail("no-textarea", "форма с описанием так и не появилась") };
}

// Что нажимать на текущем экране. Порядок важен: сначала окна поверх
// страницы, в самом конце — исходная кнопка «Создать домашнее задание».
function pickAction() {
  // Окно «Добавить материалы из урока КТП?»
  if (hasText("Добавить материалы из урока КТП")) {
    const el = findClickable("Прикрепить");
    if (el) return { key: "ktp-attach", label: "Прикрепить (материалы КТП)", el };
  }

  // Каталог материалов, ничего не выбрано → «Открыть описание»
  const openDesc = findClickable("Открыть описание", { exact: false });
  if (openDesc) return { key: "open-desc", label: "Открыть описание", el: openDesc };

  // Каталог материалов, что-то выбрано → «Прикрепить»
  if (hasText("Прикрепление материалов к домашнему заданию")) {
    const el = findClickable("Прикрепить");
    if (el) return { key: "catalog-attach", label: "Прикрепить (каталог)", el };
  }

  // Исходный экран: «Домашнее задание отсутствует»
  const create = findClickable(CREATE_BTN, { exact: false });
  if (create) return { key: "create", label: CREATE_BTN, el: create };

  return null;
}

function findDescriptionField() {
  const exact = document.querySelector('textarea[placeholder="Введите значение..."]');
  if (exact && isVisible(exact)) return exact;
  // Запасной вариант: единственная видимая textarea внутри модального окна.
  const inDialog = Array.from(
    document.querySelectorAll('[role="dialog"] textarea, [class*="modal" i] textarea, [class*="drawer" i] textarea')
  ).filter(isVisible);
  return inDialog.length === 1 ? inDialog[0] : null;
}

// ---------------------------------------------------------------------------
// Поиск и нажатие кнопок
// ---------------------------------------------------------------------------

function norm(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

// Возвращает кнопку с нужным текстом, которую реально можно нажать:
//  - самый глубокий элемент с этим текстом (а не контейнер вокруг кнопок);
//  - видимый и не disabled;
//  - не перекрыт другим окном (то, что под центром элемента, — он сам).
function findClickable(text, { exact = true } = {}) {
  const all = Array.from(document.querySelectorAll("button, [role='button'], a, div, span, p"));
  let matches = all.filter((e) => {
    const t = norm(e.textContent);
    return exact ? t === text : t.includes(text);
  });
  // Оставляем только самые глубокие совпадения: если элемент содержит
  // другое совпадение внутри себя — это контейнер, не кнопка.
  matches = matches.filter((e) => !matches.some((o) => o !== e && e.contains(o)));

  for (const m of matches) {
    const target = clickTarget(m);
    if (!isVisible(target) || isDisabled(target)) continue;
    if (isOnTop(target)) return target;
  }
  return null;
}

function clickTarget(el) {
  return el.closest("button, [role='button'], a, label") || el;
}

function isOnTop(el) {
  let r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const inView = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
  if (!inView) {
    el.scrollIntoView({ block: "center", inline: "center" });
    r = el.getBoundingClientRect();
  }
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!hit) return false;
  return hit === el || el.contains(hit) || hit.contains(el);
}

function realClick(el) {
  const r = el.getBoundingClientRect();
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
    button: 0,
  };
  el.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mousedown", base));
  el.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mouseup", base));
  el.click();
}

function isDisabled(el) {
  const btn = el.closest ? el.closest("button") : null;
  if (btn && (btn.disabled || btn.getAttribute("aria-disabled") === "true")) return true;
  if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return true;
  if (el.classList && (el.classList.contains("disabled") || el.classList.contains("Mui-disabled"))) return true;
  return false;
}

function isVisible(el) {
  if (!el || !el.getClientRects || el.getClientRects().length === 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity || "1") > 0.05;
}

// ---------------------------------------------------------------------------
// Состояние экрана и отладка
// ---------------------------------------------------------------------------

function hasText(t) {
  return document.body && document.body.innerText.includes(t);
}

// «Отпечаток» экрана — подписи видимых кнопок. Если после клика он не
// изменился, значит клик ни к чему не привёл.
function screenSignature() {
  return Array.from(document.querySelectorAll("button, [role='button']"))
    .filter(isVisible)
    .map((b) => norm(b.textContent))
    .join("|");
}

function snapshot() {
  const buttons = Array.from(document.querySelectorAll("button, [role='button']"))
    .map((b) => {
      const t = norm(b.textContent);
      if (!t || t.length > 40 || !isVisible(b)) return null;
      const flags = [];
      if (isDisabled(b)) flags.push("неактивна");
      if (!isOnTopNoScroll(b)) flags.push("перекрыта");
      return flags.length ? `${t} [${flags.join(",")}]` : t;
    })
    .filter(Boolean);
  const dialog = document.querySelector('[role="dialog"]');
  const dialogText = dialog ? norm(dialog.innerText).slice(0, 160) : "нет";
  return `кнопки: ${buttons.slice(-14).join(" | ")} :: окно: ${dialogText}`;
}

function isOnTopNoScroll(el) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
}

// ---------------------------------------------------------------------------
// Утилиты ожидания
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitFor(cond, timeout = 8000, interval = 200) {
  return waitForEl(() => (cond() ? true : null), timeout, interval).then(Boolean);
}

// Возвращает первое «истинное» значение getter() или null по таймауту.
function waitForEl(getter, timeout = 8000, interval = 200) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      let v = null;
      try {
        v = getter();
      } catch (e) {
        v = null;
      }
      if (v) return resolve(v);
      if (Date.now() - start > timeout) return resolve(null);
      setTimeout(tick, interval);
    };
    tick();
  });
}

