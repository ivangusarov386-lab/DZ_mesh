// Прогон content.js на макете страницы «Журнал» (без настоящего МЭШ).
// Проверяет readJournalCells(): каждая клетка урока помечена в коде страницы
// data-test-component="scheduleLessonCell-<id>-<СТАТУС>" (напр. HOMEWORK/DEFAULT).
// Запуск: положить рядом new_content.js (копия content.js), `node run_mock_journal.js`.
const { chromium } = require('playwright');

const EXPECTED = [
  { id: 625304900, status: 'DEFAULT' },
  { id: 625304950, status: 'DEFAULT' },
  { id: 625305000, status: 'DEFAULT' },
  { id: 625305037, status: 'HOMEWORK' },
  { id: 625305113, status: 'DEFAULT' },
  { id: 625305150, status: 'DEFAULT' },
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('ERR ' + e.message));
  await page.addInitScript(() => {
    window.chrome = { runtime: {
      sendMessage: (m) => { if (m.type === 'hw-step') console.log(m.text); return Promise.resolve(); },
      onMessage: { addListener: (f) => { window.__l = f; } },
    }, storage: {
      local: { get: (defaults, cb) => cb({ ...defaults, enabled: true }) },
      onChanged: { addListener: () => {} },
    } };
  });
  await page.goto('file://' + __dirname + '/mock_journal.html');
  await page.addScriptTag({ path: __dirname + '/new_content.js' });

  const resp = await page.evaluate(() => new Promise((res) =>
    window.__l({ type: 'read-journal' }, {}, res)));

  console.log('Ответ:', JSON.stringify(resp, null, 2));
  logs.forEach((l) => console.log('   ' + l));

  const ok = resp && resp.ok && JSON.stringify(resp.cells) === JSON.stringify(EXPECTED);
  console.log(ok ? '== СОВПАЛО с ожиданием' : '== НЕ СОВПАЛО с ожиданием!');
  if (!ok) console.log('Ожидалось:', JSON.stringify(EXPECTED));

  await browser.close();
  process.exit(ok ? 0 : 1);
})();
