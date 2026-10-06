// Прогон content.js на макете «Материалы к уроку» с карточками материалов.
// Проверяет getScenarioLaunchLink(): находит ЛЮБУЮ карточку материала (не
// только «Сценарий урока» — обобщено 06.10.2026 по просьбе Ивана «запускать
// любой урок»), открывает её «...» (data-test-component=
// "materialCardMenuList-<uuid>", подтверждено через DevTools на живом МЭШ и
// для видео, и для сценария — см. CLAUDE.md/AUTOPILOT.md), и в открывшемся
// меню берёт «Запустить», если он есть (сценарий), иначе «Просмотреть»
// (видео и другие материалы без «Запустить»). Ноль материалов или индекс за
// пределами списка — отказ без единого клика; «×» и «Удалить» не нажимаются
// ни в одном сценарии.
// Запуск: положить рядом new_content.js (копия content.js), `node run_mock_scenario.js`.
const { chromium } = require('playwright');

const CASES = [
  ['сценарий, 1-й материал → «Запустить»', 'count=2', 0, { ok: true, action: 'Запустить', hrefIncludes: '/composer3/lesson/0/management' }],
  ['сценарий, 2-й материал → «Запустить»', 'count=2', 1, { ok: true, action: 'Запустить', hrefIncludes: '/composer3/lesson/1/management' }],
  ['видеоурок (нет «Запустить») → берёт «Просмотреть»', 'count=1&kind=video', 0, { ok: true, action: 'Просмотреть', hrefIncludes: '/material_view/atomic_objects/0' }],
  ['материалов нет', 'count=0', 0, { ok: false, reason: 'no-scenario' }],
  ['такого номера нет', 'count=2', 5, { ok: false, reason: 'no-scenario' }],
];

(async () => {
  const browser = await chromium.launch();
  let allOk = true;
  for (const [name, q, index, expected] of CASES) {
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
    await page.goto('file://' + __dirname + '/mock_scenario.html?' + q);
    await page.addScriptTag({ path: __dirname + '/new_content.js' });

    const resp = await page.evaluate((i) => new Promise((res) =>
      window.__l({ type: 'get-scenario-link', index: i }, {}, res)), index);
    const side = await page.evaluate(() => ({ removed: window.__removed || 0, deleted: window.__deleted || 0 }));

    const ok =
      resp && resp.ok === expected.ok &&
      (expected.reason === undefined || resp.reason === expected.reason) &&
      (expected.action === undefined || resp.action === expected.action) &&
      (expected.hrefIncludes === undefined || (resp.href || '').includes(expected.hrefIncludes)) &&
      side.removed === 0 && side.deleted === 0;

    console.log(`== ${name}:`, JSON.stringify(resp), '| побочные:', JSON.stringify(side));
    logs.forEach((l) => console.log('   ' + l));
    console.log(ok ? '   OK' : '   FAIL');
    if (!ok) allOk = false;
    await page.close();
  }
  await browser.close();
  process.exit(allOk ? 0 : 1);
})();
