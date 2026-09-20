// Выполняется в MAIN world (в том же JS-контексте, что и сама страница МЭШ),
// поэтому видит те же запросы, что делает сама страница. Мы ничего не меняем
// и не читаем токены/куки — просто "подслушиваем" ответы, которые страница
// и так получает сама при обычной работе, и пересылаем их расширению.
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
      }
    } catch (e) {
      /* игнорируем — не мешаем странице работать */
    }
    return res;
  };
})();
