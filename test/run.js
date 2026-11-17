const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { install, initData } = require('./gas');

const S = install();
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Билеты.gs'), 'utf8') + '\n;globalThis.tk = { tkDoPost, tkSetup, tkRunJobs, tkNormCode_, tkVerifyInitData_ };', { filename: 'Билеты.gs' });

const TOKEN = '123456:TEST-token';
S.props.TK_BOT_TOKEN = TOKEN;
S.props.WEBAPP_URL = 'https://script.google.com/macros/s/ABC/exec';
S.props.TK_SCANNER_URL = 'https://konstantinmukhanov.github.io/racuni-scan/tickets.html';

let upd = 1000;
const lastTg = (method) => S.tg.filter((c) => c.method === method).pop();
const tgSince = (n) => S.tg.slice(n);
function botMsg(from, text) {
  return tk.tkDoPost({ parameter: { tk: 'bot', key: S.props.TK_WEBHOOK_KEY }, postData: { contents: JSON.stringify({ update_id: ++upd, message: { chat: { id: from.id, type: 'private' }, from, text } }) } });
}
function botBtn(from, data) {
  return tk.tkDoPost({ parameter: { tk: 'bot', key: S.props.TK_WEBHOOK_KEY }, postData: { contents: JSON.stringify({ update_id: ++upd, callback_query: { id: 'q' + upd, from, data, message: { chat: { id: from.id }, message_id: 77 } } }) } });
}
function api(user, body) {
  const out = tk.tkDoPost({ parameter: { tk: 'api' }, postData: { contents: JSON.stringify(Object.assign({ initData: user ? initData(TOKEN, user) : '' }, body)) } });
  return JSON.parse(out.content);
}
const sheetRows = (n) => S.sheets[n].rows.slice(1).filter((r) => r && r.length);
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.info('✓ ' + name); };

const ADMIN = { id: 111, first_name: 'Константин', username: 'kmukhanov' };
const KSENIA = { id: 222, first_name: 'Ксения' };
const STRANGER = { id: 333, first_name: 'Чужой' };

ok('setup: листы, вебхук, команды, меню, ссылка админа', () => {
  const link = tk.tkSetup();
  ['Показы', 'Билеты', 'Билеты · журнал', 'Билеты · команда'].forEach((n) => assert(S.sheets[n], n));
  assert.strictEqual(sheetRows('Показы').length, 6);
  const wh = lastTg('setWebhook');
  assert(wh.payload.url.startsWith(S.props.WEBAPP_URL + '?tk=bot&key='));
  const menu = lastTg('setChatMenuButton');
  assert(menu.payload.menu_button.web_app.url.includes('api=' + encodeURIComponent(S.props.WEBAPP_URL + '?tk=api')));
  assert(/^https:\/\/t\.me\/myxa_tickets_bot\?start=inv_[A-Z2-9]{16}$/.test(link), link);
  S.adminLink = link;
});

ok('повторный tkSetup не дублирует примеры показов', () => {
  tk.tkSetup();
  assert.strictEqual(sheetRows('Показы').length, 6);
});

ok('чужой человек не получает доступ', () => {
  botMsg(STRANGER, '/start');
  assert(lastTg('sendMessage').payload.text.includes('по приглашению'));
});

ok('администратор входит по ссылке, ссылка одноразовая', () => {
  const token = S.adminLink.split('inv_')[1];
  botMsg(ADMIN, '/start inv_' + token);
  const team = sheetRows('Билеты · команда');
  assert.strictEqual(team.length, 1);
  assert.deepStrictEqual([team[0][0], team[0][3], team[0][5]], ['111', 'админ', 'да']);
  assert(lastTg('sendMessage').payload.reply_markup.inline_keyboard[0][0].web_app.url);
  botMsg(STRANGER, '/start inv_' + token);
  assert(lastTg('sendMessage').payload.text.includes('уже использована'));
  assert.strictEqual(sheetRows('Билеты · команда').length, 1);
});

ok('повтор вебхука от Телеграма обрабатывается один раз', () => {
  const n = S.tg.length;
  const body = { parameter: { tk: 'bot', key: S.props.TK_WEBHOOK_KEY }, postData: { contents: JSON.stringify({ update_id: 5555, message: { chat: { id: 111, type: 'private' }, from: ADMIN, text: '/help' } }) } };
  tk.tkDoPost(body); tk.tkDoPost(body);
  assert.strictEqual(tgSince(n).filter((c) => c.method === 'sendMessage').length, 1);
});

ok('чужой ключ вебхука отклоняется', () => {
  const n = S.tg.length;
  tk.tkDoPost({ parameter: { tk: 'bot', key: 'wrong' }, postData: { contents: JSON.stringify({ update_id: 1, message: { chat: { id: 111, type: 'private' }, from: ADMIN, text: '/help' } }) } });
  assert.strictEqual(S.tg.length, n);
});

ok('админ приглашает Ксению сотрудником', () => {
  botMsg(ADMIN, '/invite');
  botBtn(ADMIN, 'inv|staff');
  const text = lastTg('editMessageText').payload.text;
  const token = text.match(/inv_([A-Z2-9]+)/)[1];
  botMsg(KSENIA, '/start inv_' + token);
  const k = sheetRows('Билеты · команда').find((r) => r[0] === '222');
  assert.strictEqual(k[3], 'сотрудник');
});

ok('сотрудник не может выпускать билеты и смотреть отчёт', () => {
  botMsg(KSENIA, '/new');
  assert(lastTg('sendMessage').payload.text.includes('администраторы'));
  botMsg(KSENIA, '/report');
  assert(lastTg('sendMessage').payload.text.includes('администраторам'));
});

ok('без макета выпуск не начинается', () => {
  botBtn(ADMIN, 'nc|F-1912-13|regular|10');
  assert(lastTg('sendMessage').payload.text.includes('нет макета'));
});

// макет на 6 билетов + лишний слайд-инструкция
const tplId = __makeTemplate(6, 1);
S.sheets['Показы'].set(2, 9, 'https://docs.google.com/presentation/d/' + tplId + '/edit');
S.sheets['Показы'].set(6, 9, 'https://docs.google.com/presentation/d/' + tplId + '/edit');
S.sheets['Показы'].set(7, 9, 'https://docs.google.com/presentation/d/' + tplId + '/edit');

ok('выпуск: кнопки → задание → PDF, 10 округляется до 12', () => {
  botMsg(ADMIN, '/new');
  const kb = lastTg('sendMessage').payload.reply_markup.inline_keyboard;
  assert(kb.length >= 6 && kb[0][0].callback_data === 'n|F-1912-13');
  botBtn(ADMIN, 'n|F-1912-13');
  assert(lastTg('editMessageText').payload.text.includes('Какие билеты'));
  botBtn(ADMIN, 'nt|F-1912-13|regular');
  const counts = lastTg('editMessageText').payload.reply_markup.inline_keyboard[0].map((b) => b.text);
  assert.deepStrictEqual(counts, ['6', '12', '30', '60']);
  botMsg(ADMIN, '10'); // число текстом
  assert.strictEqual(S.triggers.length, 1);
  tk.tkRunJobs();
  assert.strictEqual(S.triggers.length, 0);
  const tickets = sheetRows('Билеты');
  assert.strictEqual(tickets.length, 12);
  assert(tickets.every((r) => r[1] === 'F-1912-13' && r[4] === 'создан' && r[3] === 2500 && /^[A-Z2-9]{8}$/.test(r[0])));
  assert.strictEqual(new Set(tickets.map((r) => r[0])).size, 12);
  const doc = lastTg('sendDocument');
  assert.strictEqual(doc.payload.document.kind, 'pdf');
  assert(doc.payload.caption.includes('12 билетов') && doc.payload.caption.includes('просили 10'));
  assert.strictEqual(S.fetchAll, 12);
  // в копии: 2 листа, все QR заменены, коды подставлены, образец и инструкция удалены, копия в корзине
  const copy = Object.values(S.files).find((f) => f.title && f.title.startsWith('Билеты'));
  assert.strictEqual(copy.pres.slides.length, 2);
  assert(copy.pres.saved && copy.trashed);
  const codesOnPages = copy.pres.slides.map((sl) => sl.shapes.map((s) => s.text).filter((t) => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(t)));
  assert.deepStrictEqual(codesOnPages.flat(), tickets.map((r) => r[0].slice(0, 4) + '-' + r[0].slice(4)), 'порядок кодов на листах');
  assert(copy.pres.slides.every((sl) => sl.shapes.filter((s) => s.replacedWith).length === 6));
  assert(copy.pres.slides[0].shapes.some((s) => s.text === 'Финдус и Рождество'));
  assert(copy.pres.slides[0].shapes.some((s) => s.text === '19.12.2026 · 13:00'));
  assert(copy.pres.slides[0].shapes.some((s) => s.text === 'KC Grad · Braće Krsmanović 4, Beograd'));
  assert(copy.pres.slides[0].shapes.some((s) => s.text === '4–8 лет'));
  assert(copy.pres.slides[0].shapes.some((s) => s.text === 'обычный · 2 500 дин.'));
  assert(copy.pres.slides.every((sl) => sl.shapes.every((s) => !/\{\{/.test(s.text))), 'остались метки');
  const qrUrl = copy.pres.slides[0].shapes.find((s) => s.replacedWith).replacedWith.url;
  assert(qrUrl.includes(encodeURIComponent('MYXA-' + tickets[0][0])));
  assert.strictEqual(S.folder.created.length, 1);
});

ok('выпуск семейных на Клауса', () => {
  botBtn(ADMIN, 'nc|K-2612-13|family|6');
  tk.tkRunJobs();
  const fam = sheetRows('Билеты').filter((r) => r[1] === 'K-2612-13');
  assert.strictEqual(fam.length, 6);
  assert(fam.every((r) => r[2] === 'семейный (на 4)' && r[3] === 8000));
});

ok('семейные на 3: кнопка, выпуск, проход на 3 человек', () => {
  botBtn(ADMIN, 'n|K-2612-17');
  const kb = lastTg('editMessageText').payload.reply_markup.inline_keyboard.map((r) => r[0].text);
  assert.deepStrictEqual(kb, ['Обычные · 2 500 дин.', 'Семейные на 3 · 6 750 дин.', 'Семейные на 4 · 8 000 дин.']);
  botBtn(ADMIN, 'nc|K-2612-17|family3|6');
  tk.tkRunJobs();
  const f3 = sheetRows('Билеты').filter((r) => r[1] === 'K-2612-17');
  assert(f3.length === 6 && f3.every((r) => r[2] === 'семейный (на 3)' && r[3] === 6750));
  // пустой адрес: метка исчезает вместе с разделителем
  const f3copy = Object.values(S.files).filter((f) => f.title && f.title.includes('семейный (на 3)')).pop();
  assert(f3copy.pres.slides[0].shapes.some((s) => s.text === 'KC Grad · Braće Krsmanović 4, Beograd'));
  api(ADMIN, { action: 'scan', mode: 'sell', code: f3[0][0] });
  const r = api(ADMIN, { action: 'scan', mode: 'check', show: 'K-2612-17', code: f3[0][0] }).result;
  assert.strictEqual(r.title, 'Проходите · семейный, 3 чел.');
  // без цены на 3 кнопки нет
  S.sheets['Показы'].set(7, 10, '');
  botBtn(ADMIN, 'n|K-2612-17');
  assert.strictEqual(lastTg('editMessageText').payload.reply_markup.inline_keyboard.length, 2);
  S.sheets['Показы'].set(7, 10, 6750);
});

ok('пустой адрес — без разделителя', () => {
  S.sheets['Показы'].set(6, 11, '');
  botBtn(ADMIN, 'p|K-2612-13');
  tk.tkRunJobs();
  const copy = Object.values(S.files).filter((f) => f.title && f.title.startsWith('Образец')).pop();
  assert(copy.pres.slides[0].shapes.some((s) => s.text === 'KC Grad'));
  S.sheets['Показы'].set(6, 11, 'Braće Krsmanović 4, Beograd');
});

ok('образец не создаёт билеты', () => {
  const before = sheetRows('Билеты').length;
  botMsg(ADMIN, '/preview');
  botBtn(ADMIN, 'p|F-1912-13');
  tk.tkRunJobs();
  assert.strictEqual(sheetRows('Билеты').length, before);
  assert(lastTg('sendDocument').payload.caption.includes('Образец'));
});

const findus = sheetRows('Билеты').filter((r) => r[1] === 'F-1912-13').map((r) => r[0]);
const klausFam = sheetRows('Билеты').filter((r) => r[1] === 'K-2612-13').map((r) => r[0]);

ok('API: без подписи и без доступа — отказ', () => {
  assert.strictEqual(api(null, { action: 'init' }).error, 'auth');
  assert.strictEqual(api(STRANGER, { action: 'init' }).error, 'forbidden');
  const bad = initData(TOKEN, KSENIA).replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64));
  assert.strictEqual(JSON.parse(tk.tkDoPost({ parameter: { tk: 'api' }, postData: { contents: JSON.stringify({ initData: bad, action: 'init' }) } }).content).error, 'auth');
  const old = initData(TOKEN, KSENIA, Math.floor(Date.now() / 1000) - 3 * 86400);
  assert.strictEqual(JSON.parse(tk.tkDoPost({ parameter: { tk: 'api' }, postData: { contents: JSON.stringify({ initData: old, action: 'init' }) } }).content).error, 'auth');
});

ok('API init: имя, роль, показы', () => {
  const r = api(KSENIA, { action: 'init' });
  assert(r.ok);
  assert.strictEqual(r.me.role, 'сотрудник');
  assert.strictEqual(r.shows[0].code, 'F-1912-13');
  assert.strictEqual(r.shows[0].label, 'Финдус и Рождество, 19.12 в 13:00');
});

ok('продажа, повторная продажа, чужой код, мусор', () => {
  let r = api(KSENIA, { action: 'scan', mode: 'sell', code: 'MYXA-' + findus[0] }).result;
  assert.strictEqual(r.level, 'ok');
  assert.strictEqual(r.title, 'Продан · 2 500 дин.');
  assert.strictEqual(r.stats.soldPersons, 1);
  r = api(ADMIN, { action: 'scan', mode: 'sell', code: findus[0] }).result;
  assert.strictEqual(r.level, 'warn');
  assert(r.sub.includes('Ксения'));
  r = api(KSENIA, { action: 'scan', mode: 'sell', code: 'MYXA-ABCDEFGH' }).result;
  assert.strictEqual(r.title, 'Билета нет в системе');
  r = api(KSENIA, { action: 'scan', mode: 'sell', code: 'https://suf.purs.gov.rs/v/?vl=xyz' }).result;
  assert.strictEqual(r.title, 'Это не наш билет');
});

ok('ручной ввод в любом виде', () => {
  const c = findus[1];
  const typed = (c.slice(0, 4) + '-' + c.slice(4)).toLowerCase();
  const r = api(KSENIA, { action: 'scan', mode: 'sell', code: ' ' + typed + ' ' }).result;
  assert.strictEqual(r.level, 'ok');
});

ok('контроль: не продан, другой показ, проход, повтор', () => {
  let r = api(KSENIA, { action: 'scan', mode: 'check', show: 'F-1912-13', code: findus[5] }).result;
  assert.strictEqual(r.title, 'Билет не продан');
  r = api(KSENIA, { action: 'scan', mode: 'check', show: 'F-1912-16', code: findus[0] }).result;
  assert.strictEqual(r.title, 'Билет на другой показ');
  assert(r.sub.includes('19.12 в 13:00'));
  r = api(KSENIA, { action: 'scan', mode: 'check', show: 'F-1912-13', code: findus[0] }).result;
  assert.strictEqual(r.level, 'ok');
  assert.strictEqual(r.title, 'Проходите');
  assert.deepStrictEqual([r.stats.inPersons, r.stats.soldPersons, r.stats.cap], [1, 2, 80]);
  r = api(ADMIN, { action: 'scan', mode: 'check', show: 'F-1912-13', code: findus[0] }).result;
  assert.strictEqual(r.title, 'Уже прошёл');
  assert(r.sub.includes('Ксения'));
});

ok('семейный билет проходит на 4 человек', () => {
  api(ADMIN, { action: 'scan', mode: 'sell', code: klausFam[0] });
  const r = api(KSENIA, { action: 'scan', mode: 'check', show: 'K-2612-13', code: klausFam[0] }).result;
  assert.strictEqual(r.title, 'Проходите · семейный, 4 чел.');
  assert.deepStrictEqual([r.stats.inPersons, r.stats.soldPersons], [4, 4]);
});

ok('отмена своего последнего действия', () => {
  // последнее успешное действие Ксении — проход семейного
  let r = api(KSENIA, { action: 'undo' }).result;
  assert.strictEqual(r.title, 'Проход отменён');
  let t = sheetRows('Билеты').find((x) => x[0] === klausFam[0]);
  assert.strictEqual(t[4], 'продан');
  assert.strictEqual(t[9], '');
  // второй раз подряд — уже нечего
  r = api(KSENIA, { action: 'undo' }).result;
  assert.strictEqual(r.title, 'Нечего отменять');
  // админ отменяет свою продажу
  r = api(ADMIN, { action: 'undo' }).result;
  assert.strictEqual(r.title, 'Продажа отменена');
  t = sheetRows('Билеты').find((x) => x[0] === klausFam[0]);
  assert.strictEqual(t[4], 'создан');
  assert.strictEqual(t[7], '');
});

ok('stats через API', () => {
  const r = api(ADMIN, { action: 'stats', show: 'F-1912-13' });
  assert.deepStrictEqual([r.stats.soldPersons, r.stats.inPersons, r.stats.cash], [2, 1, 5000]);
});

ok('/shows и /report', () => {
  botMsg(KSENIA, '/shows');
  const shows = lastTg('sendMessage').payload.text;
  assert(shows.includes('Продано мест: 2 из 80 · прошло: 1 · выпущено билетов: 12'));
  botMsg(ADMIN, '/report');
  const rep = lastTg('sendMessage').payload.text;
  assert(rep.includes('Итого: 11 750 дин.'));
  assert(rep.includes('Константин: 6 750 дин.'));
  assert(rep.includes('Ксения: 5 000 дин.'));
});

ok('/void: проданный аннулируется, прошедший нет', () => {
  botMsg(ADMIN, '/void ' + findus[1]);
  assert(lastTg('sendMessage').payload.text.includes('аннулирован'));
  const r = api(KSENIA, { action: 'scan', mode: 'check', show: 'F-1912-13', code: findus[1] }).result;
  assert.strictEqual(r.title, 'Билет аннулирован');
  botMsg(ADMIN, '/void ' + findus[0]);
  assert(lastTg('sendMessage').payload.text.includes('нельзя'));
  assert.strictEqual(api(ADMIN, { action: 'stats', show: 'F-1912-13' }).stats.cash, 2500);
});

ok('админ убирает Ксению — доступ пропадает', () => {
  botMsg(ADMIN, '/team');
  botBtn(ADMIN, 'rm|222');
  assert.strictEqual(api(KSENIA, { action: 'init' }).error, 'forbidden');
  botBtn(ADMIN, 'rm|111');
  assert(lastTg('answerCallbackQuery').payload.text.includes('Себя'));
});

ok('ошибка в задании приходит админу, очередь не застревает', () => {
  S.sheets['Показы'].set(3, 9, 'https://docs.google.com/presentation/d/' + 'NOPE'.repeat(6) + '/edit');
  botBtn(ADMIN, 'nc|F-1912-16|regular|6');
  botBtn(ADMIN, 'nc|F-1912-13|regular|6');
  tk.tkRunJobs();
  const msgs = S.tg.slice(-3).map((c) => c.method + ':' + (c.payload.text || c.payload.caption || ''));
  assert(msgs.some((m) => m.startsWith('sendMessage:⚠️ Не получилось')), msgs.join('\n'));
  assert(lastTg('sendDocument').payload.caption.includes('19.12 в 13:00'));
  assert.strictEqual(S.props.TK_JOBS, '[]');
});

console.info('\nВсе проверки пройдены: ' + passed);
const errs = S.logs.filter((l) => l.startsWith('ERR'));
console.info('Ошибок в журнале скрипта: ' + errs.length + (errs.length ? '\n' + errs.join('\n') : ''));
