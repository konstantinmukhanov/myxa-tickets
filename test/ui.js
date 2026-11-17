// Сквозная проверка страницы сканера: настоящая страница в Chromium, настоящий Билеты.gs за API.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { install, initData } = require('./gas');

const S = install();
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Билеты.gs'), 'utf8') + '\n;globalThis.tk = { tkDoPost, tkSetup, tkRunJobs };');
const TOKEN = '123456:TEST-token';
Object.assign(S.props, { TK_BOT_TOKEN: TOKEN, WEBAPP_URL: 'https://script.google.com/macros/s/ABC/exec', TK_SCANNER_URL: 'https://example.github.io/tickets.html' });
let upd = 1;
const msg = (from, text) => tk.tkDoPost({ parameter: { tk: 'bot', key: S.props.TK_WEBHOOK_KEY }, postData: { contents: JSON.stringify({ update_id: ++upd, message: { chat: { id: from.id, type: 'private' }, from, text } }) } });
const btn = (from, data) => tk.tkDoPost({ parameter: { tk: 'bot', key: S.props.TK_WEBHOOK_KEY }, postData: { contents: JSON.stringify({ update_id: ++upd, callback_query: { id: 'q', from, data, message: { chat: { id: from.id }, message_id: 1 } } }) } });

const ADMIN = { id: 111, first_name: 'Константин' };
const link = tk.tkSetup();
msg(ADMIN, '/start inv_' + link.split('inv_')[1]);
S.sheets['Показы'].set(2, 9, 'https://docs.google.com/presentation/d/' + __makeTemplate(6) + '/edit');
btn(ADMIN, 'nc|F-1912-13|regular|6');
tk.tkRunJobs();
const codes = S.sheets['Билеты'].rows.slice(1).map((r) => r[0]);

(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2 });
  const menuUrl = S.tg.filter((c) => c.method === 'setChatMenuButton').pop().payload.menu_button.web_app.url;
  const api = new URL(menuUrl).searchParams.get('api');
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }));
  await page.route(api.split('?')[0] + '**', (r) => {
    const out = tk.tkDoPost({ parameter: { tk: new URL(r.request().url()).searchParams.get('tk') }, postData: { contents: r.request().postData() } });
    r.fulfill({ contentType: 'application/json', body: out.content, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.route('https://example.github.io/**', (r) => r.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8') }));
  await page.addInitScript(({ initData }) => {
    window.__next = [];
    window.Telegram = { WebApp: {
      initData, ready() {}, expand() {}, HapticFeedback: { notificationOccurred() {} },
      showConfirm(t, cb) { cb(true); },
      showScanQrPopup(o, cb) { const v = window.__next.shift(); if (v) setTimeout(() => cb(v), 10); },
    } };
  }, { initData: initData(TOKEN, ADMIN) });

  const shot = async (name) => page.screenshot({ path: path.join(__dirname, 'shots', name + '.png') });
  fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
  await page.goto(menuUrl);
  await page.waitForSelector('#app:not(.hidden)');
  await shot('1-sell-start');

  // продажа двух билетов подряд: первый сканом, второй вручную
  await page.evaluate((c) => window.__next.push('MYXA-' + c), codes[0]);
  await page.click('#scan');
  await page.waitForSelector('#card.ok');
  await shot('2-sold');
  await page.fill('#manual', codes[1].toLowerCase());
  await page.click('#go');
  await page.waitForFunction(() => document.querySelector('#recent').children.length === 2);

  // контроль
  await page.click('#mCheck');
  await page.waitForFunction(() => /Прошло/.test(document.querySelector('#stats').textContent));
  await shot('3-check-start');
  await page.evaluate((c) => window.__next.push('MYXA-' + c), codes[0]);
  await page.click('#scan');
  await page.waitForSelector('#card.ok');
  const okText = await page.textContent('#card');
  await shot('4-pass');
  // «подряд»: через 1,3 с сканер откроется сам — подсовываем тот же билет
  await page.evaluate((c) => window.__next.push('MYXA-' + c), codes[0]);
  await page.waitForSelector('#card.err', { timeout: 4000 });
  const dupText = await page.textContent('#card');
  await shot('5-duplicate');
  await page.evaluate((c) => window.__next.push('MYXA-' + c), codes[3]);
  await page.click('#scan');
  await page.waitForFunction(() => /не продан/.test(document.querySelector('#cT').textContent));
  await shot('6-not-sold');
  await page.click('#undo');
  await page.waitForFunction(() => /отменён/.test(document.querySelector('#cT').textContent));
  const stats = await page.textContent('#stats');
  await shot('7-undo');

  console.info('pass:', okText.trim().replace(/\s+/g, ' '));
  console.info('dup:', dupText.trim().replace(/\s+/g, ' '));
  console.info('stats after undo:', stats);
  console.info('recent:', (await page.textContent('#recent')).replace(/\s+/g, ' '));
  await browser.close();
})().catch((e) => { process.stderr.write(String(e.stack)); process.exit(1); });
