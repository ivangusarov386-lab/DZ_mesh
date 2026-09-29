// Проверяет обратное: что при ВЫКЛЮЧЕННОМ расширении (chrome.storage
// enabled=false) content.js вообще не реагирует на команды — ни одна
// кнопка на странице не нажимается, ни один шаг не пишется в лог.
// Запуск: положить рядом new_content.js (копия content.js), `node run_mock_disabled.js`.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('ERR ' + e.message));
  await page.addInitScript(() => {
    window.chrome = { runtime: {
      sendMessage: (m) => { if (m.type === 'hw-step') console.log(m.text); return Promise.resolve(); },
      onMessage: { addListener: (f) => { window.__l = f; } },
    }, storage: {
      local: { get: (defaults, cb) => cb({ ...defaults, enabled: false }) }, // ВЫКЛЮЧЕНО
      onChanged: { addListener: () => {} },
    } };
  });
  await page.goto('file://' + __dirname + '/mock.html?mode=direct');
  await page.addScriptTag({ path: __dirname + '/new_content.js' });
  await page.waitForTimeout(200); // дать chrome.storage.local.get отработать

  const result = await page.evaluate(() => {
    let responded = false;
    const returnValue = window.__l(
      { type: 'check-and-create', text: 'Не задано.', lessonDate: [2026, 9, 28] },
      {},
      () => { responded = true; }
    );
    return { returnValue, responded };
  });

  await page.waitForTimeout(1500); // с запасом, вдруг что-то сработало асинхронно

  const cardsHtml = await page.evaluate(() => document.getElementById('cards').innerHTML);
  const untouched = cardsHtml.includes('Домашнее задание отсутствует');

  console.log('Ответ на check-and-create при выключенном расширении:', JSON.stringify(result));
  console.log('Панель осталась нетронутой (ничего не кликнули):', untouched);
  console.log('Логи со страницы (должно быть пусто):', JSON.stringify(logs));

  const ok = result.returnValue === false && !result.responded && untouched && logs.length === 0;
  console.log(ok ? '== OK: выключенное расширение ничего не делает' : '== FAIL: выключенное расширение всё равно что-то сделало!');

  await browser.close();
  process.exit(ok ? 0 : 1);
})();
