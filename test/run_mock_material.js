// Прогон content.js на макете «Материалы к уроку» (без настоящего МЭШ).
// Проверяет openLessonMaterial(): находит кнопку «...» у карточки материала
// по data-test-component="materialCardMenuList-<uuid>" (подтверждено Иваном
// через DevTools 30.09.2026 — см. CLAUDE.md, «Этап 3»), кликает её, затем
// «Просмотреть» в открывшемся меню. Ноль материалов — пропускает без ошибки
// (это бывает редко, но бывает — подтверждено Иваном); несколько материалов —
// тоже пропускает (не знаем, какой открывать), не нажимая вообще ничего.
// Запуск: положить рядом new_content.js (копия content.js), `node run_mock_material.js`.
const { chromium } = require('playwright');

const CASES = [
  ['нет материала → пропустить', 'count=0', { opened: false, reason: 'no-material' }],
  ['один материал → открыть', 'count=1', { opened: true }],
  ['два материала → пропустить (не знаю какой)', 'count=2', { opened: false, reason: 'multiple-materials' }],
];

(async () => {
  const browser = await chromium.launch();
  let allOk = true;
  for (const [name, q, expected] of CASES) {
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
    await page.goto('file://' + __dirname + '/mock_material.html?' + q);
    await page.addScriptTag({ path: __dirname + '/new_content.js' });

    const resp = await page.evaluate(() => new Promise((res) =>
      window.__l({ type: 'open-material' }, {}, res)));
    const viewed = await page.evaluate(() => window.__viewedMaterial || null);

    const ok =
      resp && resp.ok === true &&
      resp.opened === expected.opened &&
      (expected.reason === undefined || resp.reason === expected.reason) &&
      (expected.opened ? viewed === 'uuid-0' : viewed === null);

    console.log(`== ${name}:`, JSON.stringify(resp), 'viewed=', viewed);
    logs.forEach((l) => console.log('   ' + l));
    console.log(ok ? '   OK' : '   FAIL');
    if (!ok) allOk = false;
    await page.close();
  }
  await browser.close();
  process.exit(allOk ? 0 : 1);
})();
