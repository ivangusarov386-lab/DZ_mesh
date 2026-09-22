// Выполняется в изолированном мире content script — имеет доступ к chrome.runtime,
// но не имеет прямого доступа к переменным страницы. Получает данные от inject.js
// через postMessage и пересылает их во всплывающее окно расширения. Также по
// команде из попапа кликает по интерфейсу так же, как это делал бы человек —
// никаких токенов и паролей это не требует.

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
    (async () => {
      const text = msg.text || "Не задано.";
      const appeared = await waitFor(
        () =>
          document.body.innerText.includes("Домашнее задание отсутствует") ||
          document.body.innerText.includes("Домашнее задание")
      );
      if (!appeared) {
        sendResponse({ ok: false, reason: "timeout" });
        return;
      }

      const missing = document.body.innerText.includes("Домашнее задание отсутствует");
      if (!missing) {
        sendResponse({ ok: true, created: false, reason: "already-exists" });
        return;
      }

      const step1 = await clickByText("Создать домашнее задание");
      if (!step1) {
        sendResponse({ ok: false, reason: "no-create-button" });
        return;
      }

      // После клика МЭШ показывает один из НЕСКОЛЬКИХ промежуточных экранов
      // перед формой с полем "Описание задания" — единого стабильного
      // сценария тут нет, встречались как минимум такие варианты:
      //  - окно "Добавить материалы из урока КТП?" с кнопкой "Прикрепить";
      //  - каталог материалов библиотеки с кнопкой "Открыть описание"
      //    (если ничего не выбрано) ИЛИ с кнопкой "Прикрепить" (если в
      //    каталоге что-то уже оказалось выбрано/подсвечено — этот
      //    вариант раньше не обрабатывался и был похож на зависание);
      //  - форма открывается сразу, без промежуточных экранов.
      // Вместо жёсткой последовательности шагов — цикл: на каждой итерации
      // смотрим, что сейчас на экране, и кликаем по первой подходящей
      // кнопке, пока не появится само поле ввода или не кончится общий
      // лимит времени. Это устойчивее к тому, какой именно экран попадётся.
      const textarea = await advanceToDescriptionForm();
      if (!textarea) {
        sendResponse({ ok: false, reason: "no-textarea", debug: visibleButtonTexts() });
        return;
      }
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      ).set;
      setter.call(textarea, text);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(500);

      const step2 = await clickByText("Выдать задание", true);
      if (!step2) {
        sendResponse({ ok: false, reason: "no-submit-button" });
        return;
      }
      await sleep(1000);

      const confirmed = await clickByText("Выдать домашнее задание", true);
      if (!confirmed) {
        sendResponse({ ok: false, reason: "no-confirm-button" });
        return;
      }
      await sleep(2200);

      // Финальная проверка: действительно ли задание появилось, а не просто
      // "тихо" ничего не произошло.
      const verified = await waitFor(
        () =>
          document.body.innerText.includes("Домашнее задание создано") ||
          document.body.innerText.includes("Задание №1"),
        6000
      );

      sendResponse({ ok: true, created: true, verified });
    })();
    return true; // ответ будет отправлен асинхронно
  }
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitFor(cond, timeout = 8000, interval = 200) {
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (cond()) {
        clearInterval(t);
        resolve(true);
      } else if (Date.now() - start > timeout) {
        clearInterval(t);
        resolve(false);
      }
    }, interval);
  });
}

// Как waitFor, но возвращает сам найденный элемент (или null по таймауту).
function waitForEl(getter, timeout = 8000, interval = 200) {
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      const el = getter();
      if (el) {
        clearInterval(t);
        resolve(el);
      } else if (Date.now() - start > timeout) {
        clearInterval(t);
        resolve(null);
      }
    }, interval);
  });
}

// Проходит через промежуточные экраны МЭШ (диалог КТП, каталог материалов
// в любом из его состояний) и возвращает найденный textarea, либо null,
// если за отведённое время форма так и не появилась. На каждой итерации
// заново смотрит на текущее состояние страницы — если промежуточный экран
// пропущен или порядок иной, чем обычно, это не ломает цикл.
async function advanceToDescriptionForm(totalTimeout = 20000, interval = 400) {
  const deadline = Date.now() + totalTimeout;
  while (Date.now() < deadline) {
    const existing = document.querySelector('textarea[placeholder="Введите значение..."]');
    if (existing) return existing;

    if (document.body.innerText.includes("Добавить материалы из урока КТП")) {
      const clicked = await clickByText("Прикрепить", true);
      if (clicked) {
        await sleep(1000);
        continue;
      }
    }

    if (document.body.innerText.includes("Открыть описание")) {
      const clicked = await clickByText("Открыть описание");
      if (clicked) {
        await sleep(1000);
        continue;
      }
    }

    // Мы в каталоге материалов, но кнопки "Открыть описание" нет — скорее
    // всего что-то в каталоге уже выбрано/подсвечено, и кнопка сейчас
    // называется "Прикрепить" (без промежуточного окна КТП). Пробуем и
    // этот вариант, раз мы точно внутри экрана каталога.
    if (document.body.innerText.includes("Прикрепление материалов к домашнему заданию")) {
      const clicked = await clickByText("Прикрепить", true);
      if (clicked) {
        await sleep(1000);
        continue;
      }
    }

    await sleep(interval);
  }
  return document.querySelector('textarea[placeholder="Введите значение..."]');
}

// Короткий снимок подписей видимых кнопок — попадает в лог попапа при
// ошибке "no-textarea", чтобы не гадать вслепую, какой именно экран
// оказался на странице в момент сбоя.
function visibleButtonTexts(max = 10) {
  const texts = Array.from(document.querySelectorAll("button"))
    .map((b) => b.textContent.trim())
    .filter((t) => t && t.length > 0 && t.length <= 40);
  return texts.slice(0, max).join(" | ");
}

function clickByText(text, exact = false) {
  return new Promise((resolve) => {
    const candidates = Array.from(document.querySelectorAll("button, div, span"));
    const el = candidates.find((e) => {
      if (e.children.length > 2) return false; // пропускаем крупные контейнеры
      const t = e.textContent.trim();
      return exact ? t === text : t.includes(text);
    });
    if (el) {
      el.click();
      resolve(true);
    } else {
      resolve(false);
    }
  });
}
