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
      await sleep(1200);

      // У части уроков перед формой описания всплывает промежуточное окно
      // "Добавить материалы из урока КТП?" (когда к уроку уже привязан
      // материал по КТП). У остальных сразу открывается каталог материалов
      // с кнопкой "Открыть описание". Обрабатываем оба варианта.
      const gotKtpDialog = await waitFor(
        () => document.body.innerText.includes("Добавить материалы из урока КТП"),
        1500
      );
      if (gotKtpDialog) {
        const attached = await clickByText("Прикрепить", true);
        if (!attached) {
          sendResponse({ ok: false, reason: "ktp-dialog-stuck" });
          return;
        }
        await sleep(900);
      } else {
        const gotCatalog = await waitFor(
          () => document.body.innerText.includes("Открыть описание"),
          2500
        );
        if (gotCatalog) {
          await clickByText("Открыть описание");
          await sleep(700);
        }
        // если ни диалог КТП, ни каталог не появились — форма описания,
        // возможно, уже открылась сама; проверяем ниже по наличию textarea
      }

      const textarea = await waitForEl(
        () => document.querySelector('textarea[placeholder="Введите значение..."]'),
        4000
      );
      if (!textarea) {
        sendResponse({ ok: false, reason: "no-textarea" });
        return;
      }
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      ).set;
      setter.call(textarea, text);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(400);

      const step2 = await clickByText("Выдать задание", true);
      if (!step2) {
        sendResponse({ ok: false, reason: "no-submit-button" });
        return;
      }
      await sleep(700);

      const confirmed = await clickByText("Выдать домашнее задание", true);
      if (!confirmed) {
        sendResponse({ ok: false, reason: "no-confirm-button" });
        return;
      }
      await sleep(1800);

      // Финальная проверка: действительно ли задание появилось, а не просто
      // "тихо" ничего не произошло.
      const verified = await waitFor(
        () =>
          document.body.innerText.includes("Домашнее задание создано") ||
          document.body.innerText.includes("Задание №1"),
        4000
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
