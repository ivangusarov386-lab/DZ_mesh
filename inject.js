// Выполняется в MAIN world (в том же JS-контексте, что и сама страница МЭШ),
// поэтому видит те же запросы, что делает сама страница. Мы ничего не меняем
// и не читаем токены/куки — просто "подслушиваем" ответы, которые страница
// и так получает сама при обычной работе, и пересылаем их расширению.
//
// ВАЖНОЕ ПРАВИЛО РАБОТЫ (задано явно): создаём «Не задано.» только для
// обычных уроков — тех, у которых во всплывающей подсказке в расписании
// ДВЕ кнопки: «К журналу» И «К уроку». Только у таких уроков вообще есть
// форма «Домашнее задание отсутствует / Создать домашнее задание».
// Такие уроки приходят с эндпоинта /api/ej/plan/teacher/v1/schedule_items —
// только его данные попадают в очередь на обработку (см. popup.js).
//
// Есть ещё два вида записей в расписании, которые НЕ подходят и никогда
// не должны попадать в очередь на создание ДЗ:
//  - внеурочная деятельность (бейдж «ВН» в расписании, напр. «Разговоры о
//    важном», «Спортивные игры») — эндпоинт
//    /api/ej/ec/teacher/v1/ec_schedule_items. Проверено вручную: в подсказке
//    у них ТОЛЬКО ОДНА кнопка — «К журналу», кнопки «К уроку» нет вообще.
//  - доп. образование / секции (бейдж «доп», напр. кружки, ШСК) — эндпоинт
//    /api/additional_education/v1/ae_schedule_items. У них нет ни статуса
//    ДЗ, ни привычной формы урока с журналом.
//
// Эти два эндпоинта мы тоже подслушиваем (только на чтение, ничего не
// меняем) — не чтобы с ними что-то делать, а чтобы расширение явно
// «видело» такие записи и честно показывало в попапе, сколько их было за
// неделю и что они осознанно пропущены, а не просто молчало о них.
(function () {
  if (window.__meshHwPatched) return;
  window.__meshHwPatched = true;

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const [urlArg, opts] = args;
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof urlArg === "string" ? urlArg : urlArg.url;
      const method = (opts && opts.method) || "GET";

      if (
        method === "GET" &&
        url.includes("/api/ej/plan/teacher/v1/schedule_items") &&
        url.includes("from=")
      ) {
        // Обычные уроки с обеими кнопками «К журналу» + «К уроку» —
        // единственный источник данных для очереди создания ДЗ.
        res
          .clone()
          .json()
          .then((data) => {
            window.postMessage({ source: "mesh-hw-ext", type: "schedule_items", data }, "*");
          })
          .catch(() => {});
      } else if (
        method === "GET" &&
        url.includes("/api/ej/core/teacher/v1/homework_presence") &&
        !url.includes("ec_")
      ) {
        res
          .clone()
          .json()
          .then((data) => {
            window.postMessage({ source: "mesh-hw-ext", type: "homework_presence", data }, "*");
          })
          .catch(() => {});
      } else if (
        method === "GET" &&
        url.includes("/api/ej/ec/teacher/v1/ec_schedule_items")
      ) {
        // Внеурочная деятельность («ВН») — только кнопка «К журналу»,
        // без «К уроку». Никогда не добавляем в очередь на ДЗ, только
        // считаем для отчёта в попапе.
        res
          .clone()
          .json()
          .then((data) => {
            window.postMessage({ source: "mesh-hw-ext", type: "ec_schedule_items", data }, "*");
          })
          .catch(() => {});
      } else if (
        method === "GET" &&
        url.includes("/api/additional_education/v1/ae_schedule_items")
      ) {
        // Доп. образование / секции («доп») — отдельная система без ДЗ
        // в журнале. Никогда не добавляем в очередь, только считаем.
        res
          .clone()
          .json()
          .then((data) => {
            window.postMessage({ source: "mesh-hw-ext", type: "ae_schedule_items", data }, "*");
          })
          .catch(() => {});
      }
    } catch (e) {
      /* игнорируем — не мешаем странице работать */
    }
    return res;
  };
})();

