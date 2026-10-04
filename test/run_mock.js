// Прогон content.js на макете панели ДЗ (без настоящего МЭШ).
// Запуск: положить рядом new_content.js (копия content.js) и выполнить `node run_mock.js`.
// Нужен playwright (npm i playwright). Дата урока в тестах — 28.09.2026.
//
// С 04.10.2026 (см. AUTOPILOT.md, раздел 3 — фикс дублей «Не задано.»)
// решение «выдано ли ДЗ на этом уроке» принимается НЕ по карточкам в
// основной панели (due=...), а по правой колонке следующего урока
// (nextcol=...) — см. комментарий в mock.html. Карточки due= в сценариях
// ниже оставлены только чтобы основная панель не была пустой (реалистичная
// картина — старые «к сдаче» карточки остаются на странице и после того,
// как на уроке выдано новое задание), на решение они больше не влияют.
const { chromium } = require('playwright');
const CASES = [
  ['пусто → создать', 'mode=direct'],
  ['окно КТП и каталог → создать', 'mode=ktp'],
  ['колонка: не выдано → создать', 'mode=ktp&due=28.09.2026&nextcol=empty'],
  ['колонка: выдано → пропустить', 'mode=direct&due=28.09.2026&nextcol=assigned'],
  ['колонка грузится медленно, но находится → пропустить', 'mode=direct&due=28.09.2026&nextcol=slow'],
  ['колонка не грузится совсем → отказ (не дублирую)', 'mode=direct&due=28.09.2026'],
  ['кнопка не работает → stuck', 'mode=dead'],
  ['незнакомое окно → unknown-screen', 'mode=weird'],
];
(async () => {
  const browser = await chromium.launch();
  for (const [name, q] of CASES) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
    const logs = [];
    page.on('console', (m) => logs.push(m.text()));
    page.on('pageerror', (e) => logs.push('ERR ' + e.message));
    await page.addInitScript(() => {
      window.chrome = { runtime: {
        sendMessage: (m) => { if (m.type === 'hw-step') console.log(m.text); return Promise.resolve(); },
        onMessage: { addListener: (f) => { window.__l = f; } },
      }, storage: {
        // Реальный chrome.storage — включено по умолчанию, как в настоящем
        // браузере. Без этого стаба content.js должен всё равно работать
        // (см. try/catch вокруг chrome.storage в content.js), но со стабом
        // проверяется настоящий путь, а не запасной.
        local: { get: (defaults, cb) => cb({ ...defaults, enabled: true }) },
        onChanged: { addListener: () => {} },
      } };
    });
    await page.goto('file://' + __dirname + '/mock.html?' + q);
    await page.evaluate(() => { document.getElementById('panel').style.marginTop = '250px'; });
    await page.addScriptTag({ path: __dirname + '/new_content.js' });
    const t0 = Date.now();
    const resp = await page.evaluate(() => new Promise((res) =>
      window.__l({ type: 'check-and-create', text: 'Не задано.', lessonDate: [2026, 9, 28] }, {}, res)));
    console.log(`== ${name}: ${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(resp));
    logs.forEach((l) => console.log('   ' + l));
    await page.close();
  }
  await browser.close();
})();
