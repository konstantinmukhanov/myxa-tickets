/**
 * Билеты.gs — служебный бот бумажных билетов Studio MYXA.
 *
 * Живёт в том же проекте Apps Script, что и бот-напоминалка («Бот.gs»), и пишет в ту же таблицу.
 * Все имена начинаются с tk / TK_, чтобы не пересекаться с «Бот.gs» и «Расчёт.gs».
 *
 * Листы:  «Показы» (заполняете вы), «Билеты», «Билеты · журнал», «Билеты · команда» (заполняет бот).
 * Свойства скрипта: TK_BOT_TOKEN, TK_SCANNER_URL (страница сканера), WEBAPP_URL (уже есть у напоминалки).
 *
 * В «Бот.gs» первой строкой функции doPost должно стоять:
 *   if (e && e.parameter && e.parameter.tk) return tkDoPost(e);
 */

const TK = {
  SHEET_SHOWS: 'Показы',
  SHEET_TICKETS: 'Билеты',
  SHEET_LOG: 'Билеты · журнал',
  SHEET_TEAM: 'Билеты · команда',
  SHOWS_HEADERS: ['Код', 'Спектакль', 'Дата', 'Время', 'Мест', 'Обычный, дин.', 'Семейный на 4, дин.', 'Площадка', 'Макет', 'Семейный на 3, дин.', 'Адрес', 'Возраст'],
  TICKETS_HEADERS: ['Код', 'Показ', 'Тип', 'Цена, дин.', 'Статус', 'Партия', 'Создан', 'Продан', 'Продал', 'Прошёл', 'Пропустил'],
  LOG_HEADERS: ['Время', 'chat_id', 'Кто', 'Режим', 'Код', 'Показ', 'Результат', 'Подробности'],
  TEAM_HEADERS: ['chat_id', 'Имя', 'Ник', 'Роль', 'Добавлен', 'Активен'],
  ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', // без 0/O и 1/I
  CODE_LEN: 8,
  QR_PREFIX: 'MYXA-',
  TZ: 'Europe/Belgrade',
  UNDO_MINUTES: 10,
  INVITE_HOURS: 48,
  INITDATA_MAX_AGE_H: 24,
  MAX_BATCH: 300,
  QR_URL: 'https://quickchart.io/qr?size=600&margin=1&ecLevel=M&text=',
  FOLDER_NAME: 'MYXA · билеты',
  STATUS: { NEW: 'создан', SOLD: 'продан', IN: 'прошёл', VOID: 'аннулирован' },
  ROLES: { admin: 'админ', staff: 'сотрудник' },
};

// индексы колонок (с нуля)
const TK_T = { code: 0, show: 1, type: 2, price: 3, status: 4, batch: 5, created: 6, sold: 7, soldBy: 8, inAt: 9, inBy: 10 };
const TK_S = { code: 0, title: 1, date: 2, time: 3, cap: 4, priceReg: 5, priceFam: 6, venue: 7, tpl: 8, priceFam3: 9, addr: 10, age: 11 };

// Типы билетов. price — поле показа с ценой; тип без цены у показа не предлагается.
const TK_TYPES = {
  regular: { label: 'обычный', button: 'Обычные', persons: 1, price: 'priceReg' },
  family3: { label: 'семейный (на 3)', button: 'Семейные на 3', persons: 3, price: 'priceFam3' },
  family: { label: 'семейный (на 4)', button: 'Семейные на 4', persons: 4, price: 'priceFam' },
};

/* ===================== Точки входа ===================== */

/** Вызывается из doPost в «Бот.gs», когда в адресе есть параметр tk. */
function tkDoPost(e) {
  const p = (e && e.parameter) || {};
  if (p.tk === 'api') return tkApi_(e);
  if (p.tk !== 'bot') return;
  const props = PropertiesService.getScriptProperties();
  if (!p.key || p.key !== props.getProperty('TK_WEBHOOK_KEY')) return;
  let update;
  try {
    update = JSON.parse(e.postData.contents);
  } catch (err) {
    return;
  }
  const cache = CacheService.getScriptCache();
  const key = 'tk_u' + update.update_id;
  if (cache.get(key)) return; // Телеграм прислал повтор
  cache.put(key, '1', 21600);
  try {
    tkHandleUpdate_(update);
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
  }
  // ничего не возвращаем — Телеграм получает 200
}

/**
 * Настройка. Перед запуском добавьте в «Свойства скрипта» TK_BOT_TOKEN (токен служебного бота от @BotFather)
 * и, если страница сканера уже опубликована, TK_SCANNER_URL.
 * Запускать повторно можно сколько угодно: ничего не ломает и каждый раз выдаёт новую ссылку для администратора.
 */
function tkSetup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TK_BOT_TOKEN')) throw new Error('Добавьте TK_BOT_TOKEN: Настройки проекта → Свойства скрипта.');
  const me = tkTg_('getMe', {});
  if (!me.ok) throw new Error('Телеграм не принял токен: ' + JSON.stringify(me));
  props.setProperty('TK_BOT_USERNAME', me.result.username);

  const ss = SpreadsheetApp.getActive();
  tkEnsureSheets_(ss);
  tkFolder_();

  const webapp = String(props.getProperty('WEBAPP_URL') || '').trim();
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(webapp)) {
    throw new Error('Нет WEBAPP_URL (адрес веб-приложения, оканчивается на /exec). Он задаётся для бота-напоминалки.');
  }
  let key = props.getProperty('TK_WEBHOOK_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('TK_WEBHOOK_KEY', key);
  }
  const wh = tkTg_('setWebhook', {
    url: webapp + '?tk=bot&key=' + key,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
    max_connections: 5,
  });
  if (!wh.ok) throw new Error('Телеграм не принял вебхук: ' + JSON.stringify(wh));

  tkTg_('setMyCommands', {
    commands: [
      { command: 'scan', description: 'Открыть сканер' },
      { command: 'shows', description: 'Показы и продажи' },
      { command: 'new', description: 'Выпустить билеты (админ)' },
      { command: 'preview', description: 'Образец билетов по макету (админ)' },
      { command: 'report', description: 'Отчёт по продажам (админ)' },
      { command: 'invite', description: 'Пригласить сотрудника (админ)' },
      { command: 'team', description: 'Команда (админ)' },
      { command: 'help', description: 'Помощь' },
    ],
  });
  const scanUrl = tkScannerUrl_();
  if (scanUrl) {
    tkTg_('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Сканер', web_app: { url: scanUrl } } });
  }

  const link = tkCreateInvite_('admin', 'setup');
  console.log(
    'Готово ✅ Бот @' + me.result.username + ' подключён.\n' +
    (scanUrl ? 'Сканер: ' + scanUrl : '⚠️ TK_SCANNER_URL не задан — кнопка сканера появится после его добавления и повторного tkSetup.') +
    '\n\nСсылка администратора (одноразовая, 48 часов):\n' + link
  );
  return link;
}

/** Состояние вебхука служебного бота — для проверки. */
function tkWebhookInfo() {
  console.log(JSON.stringify(tkTg_('getWebhookInfo', {}), null, 2));
}

/** Фоновая обработка заданий (выпуск билетов, PDF). Запускается одноразовым триггером. */
function tkRunJobs() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'tkRunJobs'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  const props = PropertiesService.getScriptProperties();
  for (let guard = 0; guard < 20; guard++) {
    const lock = tkLock_();
    lock.waitLock(30000);
    let jobs;
    try {
      jobs = JSON.parse(props.getProperty('TK_JOBS') || '[]');
      if (!jobs.length) return;
      props.setProperty('TK_JOBS', JSON.stringify(jobs.slice(1)));
    } finally {
      lock.releaseLock();
    }
    const job = jobs[0];
    try {
      tkRunJob_(job);
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      tkSend_(job.chatId, '⚠️ Не получилось: ' + tkEsc_(String(err && err.message ? err.message : err)));
    }
  }
}

/* ===================== Таблица ===================== */

function tkEnsureSheets_(ss) {
  const specs = [
    [TK.SHEET_SHOWS, TK.SHOWS_HEADERS],
    [TK.SHEET_TICKETS, TK.TICKETS_HEADERS],
    [TK.SHEET_LOG, TK.LOG_HEADERS],
    [TK.SHEET_TEAM, TK.TEAM_HEADERS],
  ];
  specs.forEach(function (spec) {
    let sh = ss.getSheetByName(spec[0]);
    if (!sh) {
      sh = ss.insertSheet(spec[0]);
      sh.getRange(1, 1, 1, spec[1].length).setValues([spec[1]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });
  // Коды билетов храним как текст, чтобы таблица их не переделывала
  ss.getSheetByName(TK.SHEET_TICKETS).getRange('A:A').setNumberFormat('@');
  ss.getSheetByName(TK.SHEET_TEAM).getRange('A:A').setNumberFormat('@');
  const shows = ss.getSheetByName(TK.SHEET_SHOWS);
  shows.getRange('A:D').setNumberFormat('@');
  // Лист из прошлой версии: дописываем недостающие заголовки справа (колонки не сдвигаются)
  const head = shows.getRange(1, 1, 1, TK.SHOWS_HEADERS.length).getDisplayValues()[0];
  TK.SHOWS_HEADERS.forEach(function (h, i) {
    if (!String(head[i] || '').trim()) shows.getRange(1, i + 1).setValue(h).setFontWeight('bold');
  });
  if (shows.getLastRow() < 2) {
    // Пример: белградский декабрь. Поправьте время и цены под себя.
    const rows = [
      ['F-1912-13', 'Финдус и Рождество', '19.12.2026', '13:00', 80, 2500, 8000, 'KC Grad', '', 6750, 'Braće Krsmanović 4, Beograd', '4–8 лет'],
      ['F-1912-16', 'Финдус и Рождество', '19.12.2026', '16:00', 80, 2500, 8000, 'KC Grad', '', 6750, 'Braće Krsmanović 4, Beograd', '4–8 лет'],
      ['F-2512-16', 'Финдус и Рождество', '25.12.2026', '16:00', 80, 2500, 8000, 'KC Grad', '', 6750, 'Braće Krsmanović 4, Beograd', '4–8 лет'],
      ['F-2512-18', 'Финдус и Рождество', '25.12.2026', '18:00', 80, 2500, 8000, 'KC Grad', '', 6750, 'Braće Krsmanović 4, Beograd', '4–8 лет'],
      ['K-2612-13', 'Почтальон для Клауса', '26.12.2026', '13:00', 80, 2500, 8000, 'KC Grad', '', 6750, 'Braće Krsmanović 4, Beograd', '7–12 лет'],
      ['K-2612-17', 'Почтальон для Клауса', '26.12.2026', '17:00', 80, 2500, 8000, 'KC Grad', '', 6750, 'Braće Krsmanović 4, Beograd', '7–12 лет'],
    ];
    shows.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
}

/** Блокировка таблицы; если документной нет (редкий случай), берём общую блокировку скрипта. */
function tkLock_() {
  return LockService.getDocumentLock() || LockService.getScriptLock();
}

function tkSheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Нет листа «' + name + '». Запустите tkSetup.');
  return sh;
}

/** Все показы из листа «Показы» (как они видны в таблице). */
function tkShows_() {
  const sh = tkSheet_(TK.SHEET_SHOWS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, TK.SHOWS_HEADERS.length).getDisplayValues()
    .map(function (r) {
      return {
        code: String(r[TK_S.code]).trim(),
        title: String(r[TK_S.title]).trim(),
        date: String(r[TK_S.date]).trim(),
        time: String(r[TK_S.time]).trim(),
        cap: Number(String(r[TK_S.cap]).replace(/\s/g, '')) || 0,
        priceReg: Number(String(r[TK_S.priceReg]).replace(/[^\d]/g, '')) || 0,
        priceFam: Number(String(r[TK_S.priceFam]).replace(/[^\d]/g, '')) || 0,
        priceFam3: Number(String(r[TK_S.priceFam3] || '').replace(/[^\d]/g, '')) || 0,
        venue: String(r[TK_S.venue]).trim(),
        addr: String(r[TK_S.addr] || '').trim(),
        age: String(r[TK_S.age] || '').trim(),
        tpl: String(r[TK_S.tpl]).trim(),
      };
    })
    .filter(function (s) { return s.code && s.title; });
}

function tkShow_(code) {
  const c = String(code || '').trim().toUpperCase();
  return tkShows_().filter(function (s) { return s.code.toUpperCase() === c; })[0] || null;
}

function tkShowLabel_(s) {
  if (!s) return '—';
  return s.title + ', ' + tkShortDate_(s.date) + ' в ' + s.time;
}

/** «12.12.2026» → «12.12» */
function tkShortDate_(d) {
  const m = String(d).match(/^(\d{1,2})\.(\d{1,2})/);
  return m ? ('0' + m[1]).slice(-2) + '.' + ('0' + m[2]).slice(-2) : String(d);
}

/** Дата показа как число ГГГГММДД (для сортировки и «сегодня»). 0 — если не распознана. */
function tkShowDay_(s) {
  const m = String(s.date).match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (!m) return 0;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return y * 10000 + Number(m[2]) * 100 + Number(m[1]);
}

function tkToday_() {
  return Number(Utilities.formatDate(new Date(), TK.TZ, 'yyyyMMdd'));
}

function tkNow_() {
  return Utilities.formatDate(new Date(), TK.TZ, 'dd.MM.yyyy HH:mm:ss');
}

function tkHm_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TK.TZ, 'HH:mm');
  const m = String(v || '').match(/(\d{1,2}:\d{2})/);
  return m ? m[1] : String(v || '');
}

/* ===================== Коды ===================== */

function tkRandomCode_() {
  const a = TK.ALPHABET;
  const bytes = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  let out = '';
  for (let i = 0; i < TK.CODE_LEN; i++) out += a[parseInt(bytes.substr(i * 2, 2), 16) % a.length];
  return out;
}

/** Текст из QR или введённый руками → код из 8 знаков, либо '' если не похоже на билет. */
function tkNormCode_(text) {
  let s = String(text || '').trim().toUpperCase();
  if (s.indexOf(TK.QR_PREFIX) === 0) s = s.slice(TK.QR_PREFIX.length);
  s = s.replace(/[\s\-–—]/g, '');
  return new RegExp('^[' + TK.ALPHABET + ']{' + TK.CODE_LEN + '}$').test(s) ? s : '';
}

/** «7KQ3M9PX» → «7KQ3-M9PX» */
function tkPretty_(code) {
  return code.slice(0, 4) + '-' + code.slice(4);
}

/* ===================== Команда и доступ ===================== */

function tkTeam_() {
  const sh = tkSheet_(TK.SHEET_TEAM);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, TK.TEAM_HEADERS.length).getValues().map(function (r, i) {
    return { row: i + 2, id: String(r[0]), name: String(r[1]), nick: String(r[2]), role: String(r[3]), active: String(r[5]) !== 'нет' };
  });
}

function tkMember_(chatId) {
  const id = String(chatId);
  return tkTeam_().filter(function (m) { return m.id === id && m.active; })[0] || null;
}

function tkIsAdmin_(m) {
  return !!m && m.role === TK.ROLES.admin;
}

function tkCreateInvite_(role, by) {
  const token = tkRandomCode_() + tkRandomCode_();
  PropertiesService.getScriptProperties().setProperty(
    'TK_INV_' + token,
    JSON.stringify({ role: role, exp: Date.now() + TK.INVITE_HOURS * 3600e3, by: String(by) })
  );
  return 'https://t.me/' + PropertiesService.getScriptProperties().getProperty('TK_BOT_USERNAME') + '?start=inv_' + token;
}

/** Принять приглашение. Возвращает участника или текст ошибки. */
function tkAcceptInvite_(token, from) {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('TK_INV_' + token);
  if (!raw) return 'Ссылка-приглашение не найдена или уже использована. Попросите новую.';
  const inv = JSON.parse(raw);
  props.deleteProperty('TK_INV_' + token);
  if (Date.now() > inv.exp) return 'Срок действия ссылки истёк. Попросите новую.';
  const role = inv.role === 'admin' ? TK.ROLES.admin : TK.ROLES.staff;
  const sh = tkSheet_(TK.SHEET_TEAM);
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
  const nick = from.username ? '@' + from.username : '';
  const existing = tkTeam_().filter(function (m) { return m.id === String(from.id); })[0];
  const row = [String(from.id), name, nick, role, tkNow_(), 'да'];
  if (existing) {
    // повышать можно, понижать админа приглашением сотрудника — нет
    if (existing.role === TK.ROLES.admin && existing.active) row[3] = TK.ROLES.admin;
    sh.getRange(existing.row, 1, 1, row.length).setValues([row]);
  } else {
    sh.appendRow(row);
  }
  return { id: String(from.id), name: name, nick: nick, role: row[3], active: true };
}

/* ===================== Билеты: поиск, продажа, проход ===================== */

function tkFindTicket_(code) {
  const sh = tkSheet_(TK.SHEET_TICKETS);
  const last = sh.getLastRow();
  if (last < 2) return null;
  const cell = sh.getRange(2, 1, last - 1, 1).createTextFinder(code).matchEntireCell(true).findNext();
  if (!cell) return null;
  const row = cell.getRow();
  const v = sh.getRange(row, 1, 1, TK.TICKETS_HEADERS.length).getValues()[0];
  return {
    row: row,
    code: String(v[TK_T.code]),
    show: String(v[TK_T.show]),
    type: String(v[TK_T.type]),
    price: Number(v[TK_T.price]) || 0,
    status: String(v[TK_T.status]),
    sold: v[TK_T.sold],
    soldBy: String(v[TK_T.soldBy]),
    inAt: v[TK_T.inAt],
    inBy: String(v[TK_T.inBy]),
  };
}

function tkPersons_(typeLabel) {
  const s = String(typeLabel);
  if (s.indexOf('семейный') !== 0) return 1;
  const m = s.match(/на (\d+)/);
  return m ? Number(m[1]) : 4;
}

/** Сводка по показу: проданные и прошедшие места, сумма. */
function tkStats_(showCode) {
  const sh = tkSheet_(TK.SHEET_TICKETS);
  const last = sh.getLastRow();
  const st = { created: 0, soldTickets: 0, soldPersons: 0, inPersons: 0, cash: 0, bySeller: {} };
  if (last < 2) return st;
  const c = String(showCode).toUpperCase();
  sh.getRange(2, 1, last - 1, TK.TICKETS_HEADERS.length).getValues().forEach(function (r) {
    if (String(r[TK_T.show]).toUpperCase() !== c) return;
    const status = String(r[TK_T.status]);
    if (status === TK.STATUS.VOID) return;
    st.created++;
    if (status === TK.STATUS.SOLD || status === TK.STATUS.IN) {
      const p = tkPersons_(r[TK_T.type]);
      const price = Number(r[TK_T.price]) || 0;
      st.soldTickets++;
      st.soldPersons += p;
      st.cash += price;
      const who = String(r[TK_T.soldBy]) || '—';
      st.bySeller[who] = (st.bySeller[who] || 0) + price;
      if (status === TK.STATUS.IN) st.inPersons += p;
    }
  });
  return st;
}

function tkLog_(member, mode, code, show, result, details) {
  tkSheet_(TK.SHEET_LOG).appendRow([new Date(), String(member.id), member.name, mode, code, show, result, details || '']);
}

/**
 * Обработка одного скана. mode: 'sell' | 'check'. showCode — выбранный показ (для контроля).
 * Возвращает { level: 'ok'|'warn'|'err', title, sub, ticket?, stats? }.
 */
function tkScan_(member, mode, showCode, rawText) {
  const code = tkNormCode_(rawText);
  if (!code) {
    tkLog_(member, mode, String(rawText).slice(0, 40), '', 'не билет', '');
    return { level: 'err', title: 'Это не наш билет', sub: 'Код не похож на билет MYXA.' };
  }
  const lock = tkLock_();
  if (!lock.tryLock(15000)) return { level: 'err', title: 'Таблица занята', sub: 'Попробуйте ещё раз через пару секунд.' };
  try {
    const t = tkFindTicket_(code);
    if (!t) {
      tkLog_(member, mode, code, '', 'нет в системе', '');
      return { level: 'err', title: 'Билета нет в системе', sub: tkPretty_(code) + ' — такой код не выпускался.' };
    }
    const show = tkShow_(t.show);
    const info = { code: tkPretty_(t.code), show: tkShowLabel_(show) || t.show, type: t.type, persons: tkPersons_(t.type) };
    const sh = tkSheet_(TK.SHEET_TICKETS);

    if (t.status === TK.STATUS.VOID) {
      tkLog_(member, mode, code, t.show, 'аннулирован', '');
      return { level: 'err', title: 'Билет аннулирован', sub: info.code + ' · ' + info.show, ticket: info };
    }

    if (mode === 'sell') {
      if (t.status === TK.STATUS.SOLD || t.status === TK.STATUS.IN) {
        tkLog_(member, mode, code, t.show, 'уже продан', '');
        return {
          level: 'warn', title: 'Уже продан',
          sub: 'Продал(а) ' + (t.soldBy || '—') + ' в ' + tkHm_(t.sold) + (t.status === TK.STATUS.IN ? '. Уже прошёл на вход.' : '.'),
          ticket: info, stats: tkStatsBrief_(t.show, show),
        };
      }
      sh.getRange(t.row, TK_T.status + 1).setValue(TK.STATUS.SOLD);
      sh.getRange(t.row, TK_T.sold + 1, 1, 2).setValues([[new Date(), member.name]]);
      tkLog_(member, mode, code, t.show, 'продан', t.price + ' дин.');
      return {
        level: 'ok', title: 'Продан · ' + tkMoney_(t.price) + ' дин.',
        sub: info.show + ' · ' + t.type, ticket: info, stats: tkStatsBrief_(t.show, show),
      };
    }

    // контроль
    if (showCode && String(showCode).toUpperCase() !== t.show.toUpperCase()) {
      tkLog_(member, mode, code, t.show, 'другой показ', 'выбран ' + showCode);
      return { level: 'err', title: 'Билет на другой показ', sub: info.show, ticket: info };
    }
    if (t.status === TK.STATUS.NEW) {
      tkLog_(member, mode, code, t.show, 'не продан', '');
      return { level: 'err', title: 'Билет не продан', sub: 'Сначала продайте его в режиме «Продажа».', ticket: info };
    }
    if (t.status === TK.STATUS.IN) {
      tkLog_(member, mode, code, t.show, 'повтор', '');
      return {
        level: 'err', title: 'Уже прошёл',
        sub: 'В ' + tkHm_(t.inAt) + ', пропустил(а) ' + (t.inBy || '—') + '.',
        ticket: info, stats: tkStatsBrief_(t.show, show),
      };
    }
    sh.getRange(t.row, TK_T.status + 1).setValue(TK.STATUS.IN);
    sh.getRange(t.row, TK_T.inAt + 1, 1, 2).setValues([[new Date(), member.name]]);
    tkLog_(member, mode, code, t.show, 'прошёл', info.persons + ' чел.');
    return {
      level: 'ok', title: info.persons > 1 ? 'Проходите · семейный, ' + info.persons + ' чел.' : 'Проходите',
      sub: info.show, ticket: info, stats: tkStatsBrief_(t.show, show),
    };
  } finally {
    lock.releaseLock();
  }
}

function tkStatsBrief_(showCode, show) {
  const st = tkStats_(showCode);
  return { soldPersons: st.soldPersons, inPersons: st.inPersons, cap: show ? show.cap : 0, cash: st.cash };
}

/** Отменить своё последнее действие (продажу или проход) за последние TK.UNDO_MINUTES минут. */
function tkUndo_(member) {
  const lock = tkLock_();
  if (!lock.tryLock(15000)) return { level: 'err', title: 'Таблица занята', sub: 'Попробуйте ещё раз.' };
  try {
    const log = tkSheet_(TK.SHEET_LOG);
    const last = log.getLastRow();
    if (last < 2) return { level: 'warn', title: 'Нечего отменять', sub: '' };
    const from = Math.max(2, last - 300);
    const rows = log.getRange(from, 1, last - from + 1, TK.LOG_HEADERS.length).getValues();
    const limit = Date.now() - TK.UNDO_MINUTES * 60e3;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (String(r[1]) !== String(member.id)) continue;
      const when = r[0] instanceof Date ? r[0].getTime() : 0;
      if (when < limit) break;
      const result = String(r[6]);
      if (result === 'отменено') break; // последнее действие уже отменено
      if (result !== 'продан' && result !== 'прошёл') continue;
      const t = tkFindTicket_(String(r[4]));
      if (!t) break;
      const sh = tkSheet_(TK.SHEET_TICKETS);
      if (result === 'прошёл' && t.status === TK.STATUS.IN) {
        sh.getRange(t.row, TK_T.status + 1).setValue(TK.STATUS.SOLD);
        sh.getRange(t.row, TK_T.inAt + 1, 1, 2).setValues([['', '']]);
      } else if (result === 'продан' && t.status === TK.STATUS.SOLD) {
        sh.getRange(t.row, TK_T.status + 1).setValue(TK.STATUS.NEW);
        sh.getRange(t.row, TK_T.sold + 1, 1, 2).setValues([['', '']]);
      } else {
        return { level: 'warn', title: 'Не получилось отменить', sub: 'Билет уже изменился после вашего действия.' };
      }
      log.getRange(from + i, 8).setValue(String(r[7] || '') + ' (отменено)');
      tkLog_(member, 'отмена', t.code, t.show, 'отменено', result);
      return {
        level: 'ok', title: result === 'продан' ? 'Продажа отменена' : 'Проход отменён',
        sub: tkPretty_(t.code) + ' · ' + tkShowLabel_(tkShow_(t.show)),
      };
    }
    return { level: 'warn', title: 'Нечего отменять', sub: 'Отменить можно своё действие за последние ' + TK.UNDO_MINUTES + ' минут.' };
  } finally {
    lock.releaseLock();
  }
}

/* ===================== API для страницы сканера ===================== */

function tkJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function tkApi_(e) {
  let req;
  try {
    req = JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return tkJson_({ ok: false, error: 'bad_request' });
  }
  const user = tkVerifyInitData_(req.initData);
  if (!user) return tkJson_({ ok: false, error: 'auth', message: 'Откройте сканер кнопкой в служебном боте.' });
  const member = tkMember_(user.id);
  if (!member) return tkJson_({ ok: false, error: 'forbidden', message: 'У вас нет доступа. Попросите приглашение у администратора.' });
  try {
    switch (req.action) {
      case 'init':
        return tkJson_({ ok: true, me: { name: member.name, role: member.role }, shows: tkApiShows_(), today: tkToday_() });
      case 'scan':
        return tkJson_({ ok: true, result: tkScan_(member, req.mode === 'check' ? 'check' : 'sell', req.show || '', req.code) });
      case 'undo':
        return tkJson_({ ok: true, result: tkUndo_(member) });
      case 'stats': {
        const show = tkShow_(req.show);
        return tkJson_({ ok: true, stats: show ? tkStatsBrief_(show.code, show) : null });
      }
      default:
        return tkJson_({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return tkJson_({ ok: false, error: 'server', message: String(err && err.message ? err.message : err) });
  }
}

function tkApiShows_() {
  const today = tkToday_();
  return tkShows_()
    .map(function (s) { return { code: s.code, label: tkShowLabel_(s), day: tkShowDay_(s), cap: s.cap }; })
    .filter(function (s) { return !s.day || s.day >= today - 1; })
    .sort(function (a, b) { return a.day - b.day || (a.label < b.label ? -1 : 1); });
}

/** Проверка подписи Telegram Mini App. Возвращает пользователя или null. */
function tkVerifyInitData_(initData) {
  if (!initData || typeof initData !== 'string') return null;
  const token = PropertiesService.getScriptProperties().getProperty('TK_BOT_TOKEN');
  if (!token) return null;
  const pairs = {};
  initData.split('&').forEach(function (part) {
    const i = part.indexOf('=');
    if (i < 0) return;
    pairs[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1).replace(/\+/g, '%20'));
  });
  const hash = pairs.hash;
  if (!hash) return null;
  delete pairs.hash;
  const dcs = Object.keys(pairs).sort().map(function (k) { return k + '=' + pairs[k]; }).join('\n');
  const secret = Utilities.computeHmacSha256Signature(Utilities.newBlob(token).getBytes(), Utilities.newBlob('WebAppData').getBytes());
  const sig = Utilities.computeHmacSha256Signature(Utilities.newBlob(dcs).getBytes(), secret);
  const hex = sig.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
  if (hex !== String(hash).toLowerCase()) return null;
  const authDate = Number(pairs.auth_date || 0);
  if (!authDate || Date.now() / 1000 - authDate > TK.INITDATA_MAX_AGE_H * 3600) return null;
  try {
    const u = JSON.parse(pairs.user || 'null');
    return u && u.id ? u : null;
  } catch (err) {
    return null;
  }
}

function tkScannerUrl_() {
  const props = PropertiesService.getScriptProperties();
  const base = String(props.getProperty('TK_SCANNER_URL') || '').trim();
  const webapp = String(props.getProperty('WEBAPP_URL') || '').trim();
  if (!base || !webapp) return '';
  return base + (base.indexOf('?') < 0 ? '?' : '&') + 'api=' + encodeURIComponent(webapp + '?tk=api');
}

/* ===================== Телеграм ===================== */

function tkTg_(method, payload) {
  const token = PropertiesService.getScriptProperties().getProperty('TK_BOT_TOKEN');
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  try {
    return JSON.parse(res.getContentText());
  } catch (err) {
    return { ok: false, description: res.getContentText() };
  }
}

function tkSend_(chatId, html, keyboard) {
  const p = { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true };
  if (keyboard) p.reply_markup = keyboard;
  return tkTg_('sendMessage', p);
}

function tkEdit_(chatId, messageId, html, keyboard) {
  const p = { chat_id: chatId, message_id: messageId, text: html, parse_mode: 'HTML', disable_web_page_preview: true };
  if (keyboard) p.reply_markup = keyboard;
  return tkTg_('editMessageText', p);
}

function tkSendDocument_(chatId, blob, caption) {
  const token = PropertiesService.getScriptProperties().getProperty('TK_BOT_TOKEN');
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendDocument', {
    method: 'post', payload: { chat_id: String(chatId), caption: caption || '', parse_mode: 'HTML', document: blob }, muteHttpExceptions: true,
  });
  return JSON.parse(res.getContentText());
}

function tkEsc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tkMoney_(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// Кнопки внизу экрана (обычная клавиатура Телеграма): текст кнопки → команда
const TK_MENU = {
  '📷 Сканер': 'scan', '📋 Показы': 'shows', '❓ Помощь': 'help',
  '🖨 Выпустить': 'new', '🧪 Образец': 'preview', '📊 Отчёт': 'report',
  '🚫 Аннулировать': 'void', '👥 Команда': 'team', '➕ Пригласить': 'invite',
};

function tkMenuKeyboard_(member) {
  const rows = tkIsAdmin_(member)
    ? [['📷 Сканер', '📋 Показы'], ['🖨 Выпустить', '🧪 Образец'], ['📊 Отчёт', '🚫 Аннулировать'], ['👥 Команда', '➕ Пригласить', '❓ Помощь']]
    : [['📷 Сканер', '📋 Показы'], ['❓ Помощь']];
  return {
    keyboard: rows.map(function (r) { return r.map(function (t) { return { text: t }; }); }),
    resize_keyboard: true, is_persistent: true,
  };
}

function tkScanKeyboard_() {
  const url = tkScannerUrl_();
  return url ? { inline_keyboard: [[{ text: '📷 Открыть сканер', web_app: { url: url } }]] } : null;
}

/* ===================== Бот: сообщения и кнопки ===================== */

function tkHandleUpdate_(update) {
  if (update.callback_query) return tkHandleCallback_(update.callback_query);
  const m = update.message;
  if (!m || !m.chat || m.chat.type !== 'private') return;
  const chatId = m.chat.id;
  const text = String(m.text || '').trim();

  // приглашение
  const inv = text.match(/^\/start\s+inv_([A-Z2-9]+)$/);
  if (inv) {
    const res = tkAcceptInvite_(inv[1], m.from);
    if (typeof res === 'string') return tkSend_(chatId, '⚠️ ' + res);
    return tkSend_(chatId,
      '👋 ' + tkEsc_(res.name) + ', вы в команде билетов Studio MYXA как <b>' + res.role + '</b>.\n\n' + tkHelpText_(res),
      tkMenuKeyboard_(res));
  }

  const member = tkMember_(chatId);
  if (!member) {
    return tkSend_(chatId, 'Это служебный бот билетов Studio MYXA. Доступ — по приглашению администратора.', { remove_keyboard: true });
  }

  const button = TK_MENU[text];
  const cmd = button || (text.match(/^\/(\w+)/) || [])[1];

  // ожидаем число билетов или код для аннулирования
  const state = tkState_(chatId);
  if (state && !cmd) {
    if (state.await === 'count' && /^\d{1,3}$/.test(text)) {
      tkClearState_(chatId);
      return tkStartBatch_(chatId, member, state.show, state.type, Number(text), false);
    }
    if (state.await === 'void' && tkIsAdmin_(member)) {
      const vcode = tkNormCode_(text);
      if (!vcode) return tkSend_(chatId, 'Не похоже на код билета. Пришлите код, например <code>7KQ3-M9PX</code>.');
      tkClearState_(chatId);
      return tkVoid_(chatId, member, vcode);
    }
  }
  if (cmd && state) tkClearState_(chatId);

  switch (cmd) {
    case 'start':
    case 'help':
      return tkSend_(chatId, tkHelpText_(member), tkMenuKeyboard_(member));
    case 'scan': {
      const kb = tkScanKeyboard_();
      return tkSend_(chatId, kb ? 'Сканер билетов:' : '⚠️ Страница сканера ещё не подключена (TK_SCANNER_URL).', kb);
    }
    case 'shows':
      return tkSend_(chatId, tkShowsText_());
    case 'report':
      if (!tkIsAdmin_(member)) return tkSend_(chatId, 'Отчёт доступен администраторам.');
      return tkSend_(chatId, tkReportText_());
    case 'new':
    case 'preview':
      if (!tkIsAdmin_(member)) return tkSend_(chatId, 'Выпускать билеты могут администраторы.');
      return tkAskShow_(chatId, cmd === 'new' ? 'n' : 'p');
    case 'invite':
      if (!tkIsAdmin_(member)) return tkSend_(chatId, 'Приглашать могут администраторы.');
      return tkSend_(chatId, 'Кого пригласить?', {
        inline_keyboard: [[
          { text: '🎟 Сотрудника (продажа и вход)', callback_data: 'inv|staff' },
          { text: '🔑 Администратора', callback_data: 'inv|admin' },
        ]],
      });
    case 'team':
      if (!tkIsAdmin_(member)) return tkSend_(chatId, 'Список команды доступен администраторам.');
      return tkSendTeam_(chatId);
    case 'void': {
      if (!tkIsAdmin_(member)) return tkSend_(chatId, 'Аннулировать билеты могут администраторы.');
      const code = button ? '' : tkNormCode_(text.replace(/^\/void\s*/, ''));
      if (!code) {
        tkSetState_(chatId, { await: 'void' });
        return tkSend_(chatId, '🚫 Пришлите код билета, который нужно аннулировать (например <code>7KQ3-M9PX</code>).');
      }
      return tkVoid_(chatId, member, code);
    }
    default:
      return tkSend_(chatId, tkHelpText_(member), tkMenuKeyboard_(member));
  }
}

function tkHelpText_(m) {
  let s = '<b>Как работать</b>\nВсё есть на кнопках внизу экрана; команды через «/» тоже работают.\n\n' +
    '📷 Сканер (/scan) — открыть сканер. Вверху выберите режим:\n' +
    '• <b>Продажа</b> — сканируйте билет, который отдаёте за наличные;\n' +
    '• <b>Контроль</b> — выберите показ и сканируйте билеты на входе.\n' +
    'Ошиблись — кнопка «Отменить последнее» в сканере (' + TK.UNDO_MINUTES + ' минут).\n\n' +
    '📋 Показы (/shows) — показы и сколько продано.';
  if (tkIsAdmin_(m)) {
    s += '\n\n<b>Для администратора</b>\n' +
      '🖨 Выпустить (/new) — билеты в PDF для печати\n' +
      '🧪 Образец (/preview) — пробный лист по макету, без выпуска\n' +
      '📊 Отчёт (/report) — продажи и наличные\n' +
      '🚫 Аннулировать (/void) — потерянный билет\n' +
      '➕ Пригласить (/invite) · 👥 Команда (/team)';
  }
  return s;
}

function tkShowsText_() {
  const shows = tkApiShows_();
  if (!shows.length) return 'Ближайших показов нет. Добавьте их на лист «Показы».';
  return '<b>Показы</b>\n' + shows.map(function (s) {
    const st = tkStats_(s.code);
    return '\n<b>' + tkEsc_(s.label) + '</b> <code>' + s.code + '</code>\n' +
      'Продано мест: ' + st.soldPersons + (s.cap ? ' из ' + s.cap : '') + ' · прошло: ' + st.inPersons +
      ' · выпущено билетов: ' + st.created;
  }).join('\n');
}

function tkReportText_() {
  const shows = tkShows_();
  if (!shows.length) return 'Показов нет.';
  let total = 0;
  const sellers = {};
  const lines = shows.map(function (s) {
    const st = tkStats_(s.code);
    total += st.cash;
    Object.keys(st.bySeller).forEach(function (k) { sellers[k] = (sellers[k] || 0) + st.bySeller[k]; });
    return '<b>' + tkEsc_(tkShowLabel_(s)) + '</b>\n' +
      'продано билетов: ' + st.soldTickets + ' (' + st.soldPersons + ' мест) · пришло: ' + st.inPersons +
      '\nналичными: ' + tkMoney_(st.cash) + ' дин.';
  });
  const sel = Object.keys(sellers).map(function (k) { return '• ' + tkEsc_(k) + ': ' + tkMoney_(sellers[k]) + ' дин.'; });
  return '<b>Бумажные билеты, наличные</b>\n\n' + lines.join('\n\n') +
    '\n\n<b>Итого: ' + tkMoney_(total) + ' дин.</b>' + (sel.length ? '\nПо продавцам:\n' + sel.join('\n') : '');
}

function tkAskShow_(chatId, kind) {
  const shows = tkApiShows_();
  if (!shows.length) return tkSend_(chatId, 'Нет ближайших показов. Добавьте их на лист «Показы».');
  return tkSend_(chatId, kind === 'n' ? '🖨 На какой показ выпустить билеты?' : '🧪 Образец для какого показа?', {
    inline_keyboard: shows.map(function (s) { return [{ text: s.label, callback_data: kind + '|' + s.code }]; }),
  });
}

function tkSendTeam_(chatId) {
  const team = tkTeam_().filter(function (m) { return m.active; });
  if (!team.length) return tkSend_(chatId, 'В команде пока никого.');
  return tkSend_(chatId, '<b>Команда</b>\n' + team.map(function (m) {
    return '• ' + tkEsc_(m.name) + (m.nick ? ' ' + tkEsc_(m.nick) : '') + ' — ' + m.role;
  }).join('\n'), {
    inline_keyboard: team.map(function (m) { return [{ text: '✖ Убрать: ' + m.name, callback_data: 'rm|' + m.id }]; }),
  });
}

function tkVoid_(chatId, member, code) {
  const lock = tkLock_();
  lock.waitLock(15000);
  try {
    const t = tkFindTicket_(code);
    if (!t) return tkSend_(chatId, 'Билета ' + tkPretty_(code) + ' нет в системе.');
    if (t.status === TK.STATUS.IN) return tkSend_(chatId, 'Билет ' + tkPretty_(code) + ' уже прошёл на вход — аннулировать нельзя.');
    tkSheet_(TK.SHEET_TICKETS).getRange(t.row, TK_T.status + 1).setValue(TK.STATUS.VOID);
    tkLog_(member, 'аннулирование', code, t.show, 'аннулирован', 'был: ' + t.status);
    return tkSend_(chatId, '🚫 Билет ' + tkPretty_(code) + ' аннулирован (' + tkEsc_(tkShowLabel_(tkShow_(t.show))) + ').' +
      (t.status === TK.STATUS.SOLD ? '\nОн был продан — деньги в отчёте больше не учитываются.' : ''));
  } finally {
    lock.releaseLock();
  }
}

function tkHandleCallback_(q) {
  const chatId = q.message && q.message.chat ? q.message.chat.id : q.from.id;
  const mid = q.message ? q.message.message_id : null;
  const member = tkMember_(q.from.id);
  const answer = function (text) { tkTg_('answerCallbackQuery', { callback_query_id: q.id, text: text || '' }); };
  if (!member) return answer('Нет доступа');
  const parts = String(q.data || '').split('|');
  const admin = tkIsAdmin_(member);
  switch (parts[0]) {
    case 'n': // показ выбран → тип
    case 'p': {
      if (!admin) return answer('Только для администраторов');
      const show = tkShow_(parts[1]);
      if (!show) return answer('Показ не найден');
      answer();
      if (parts[0] === 'p') {
        tkEdit_(chatId, mid, '🧪 Готовлю образец: ' + tkEsc_(tkShowLabel_(show)) + '…');
        return tkEnqueue_({ kind: 'preview', chatId: chatId, show: show.code, type: 'regular', by: member.name });
      }
      const kinds = Object.keys(TK_TYPES).filter(function (k) { return k === 'regular' || show[TK_TYPES[k].price] > 0; });
      return tkEdit_(chatId, mid, '🖨 ' + tkEsc_(tkShowLabel_(show)) + '\nКакие билеты?', {
        inline_keyboard: kinds.map(function (k) {
          return [{ text: TK_TYPES[k].button + ' · ' + tkMoney_(show[TK_TYPES[k].price]) + ' дин.', callback_data: 'nt|' + show.code + '|' + k }];
        }),
      });
    }
    case 'nt': { // тип выбран → количество
      if (!admin) return answer('Только для администраторов');
      const show = tkShow_(parts[1]);
      const type = TK_TYPES[parts[2]] ? parts[2] : 'regular';
      if (!show) return answer('Показ не найден');
      answer();
      const per = tkPerPageHint_(show);
      tkSetState_(chatId, { await: 'count', show: show.code, type: type });
      const opts = [1, 2, 5, 10].map(function (k) { return k * per; });
      return tkEdit_(chatId, mid,
        '🖨 ' + tkEsc_(tkShowLabel_(show)) + ' · ' + TK_TYPES[type].label + '\nСколько билетов? ' +
        'Выберите или напишите число — я округлю вверх до целых листов (по ' + per + ' на листе).', {
          inline_keyboard: [opts.map(function (k) { return { text: String(k), callback_data: 'nc|' + show.code + '|' + type + '|' + k }; })],
        });
    }
    case 'nc': { // количество выбрано
      if (!admin) return answer('Только для администраторов');
      answer();
      tkClearState_(chatId);
      if (mid) tkEdit_(chatId, mid, '🖨 Принято.');
      return tkStartBatch_(chatId, member, parts[1], parts[2], Number(parts[3]), false);
    }
    case 'inv': {
      if (!admin) return answer('Только для администраторов');
      answer();
      const role = parts[1] === 'admin' ? 'admin' : 'staff';
      const link = tkCreateInvite_(role, member.id);
      return tkEdit_(chatId, mid,
        (role === 'admin' ? '🔑 Приглашение администратора' : '🎟 Приглашение сотрудника') +
        ' (одноразовое, ' + TK.INVITE_HOURS + ' часа). Перешлите человеку:\n\n' + link);
    }
    case 'rm': {
      if (!admin) return answer('Только для администраторов');
      if (parts[1] === String(member.id)) return answer('Себя убрать нельзя');
      const m = tkTeam_().filter(function (x) { return x.id === parts[1]; })[0];
      if (!m) return answer('Не найден');
      tkSheet_(TK.SHEET_TEAM).getRange(m.row, 6).setValue('нет');
      answer('Убрали: ' + m.name);
      return tkSendTeam_(chatId);
    }
    default:
      return answer();
  }
}

/* ===================== Состояние диалога ===================== */

function tkState_(chatId) {
  const raw = CacheService.getScriptCache().get('tk_st_' + chatId);
  return raw ? JSON.parse(raw) : null;
}
function tkSetState_(chatId, st) {
  CacheService.getScriptCache().put('tk_st_' + chatId, JSON.stringify(st), 1800);
}
function tkClearState_(chatId) {
  CacheService.getScriptCache().remove('tk_st_' + chatId);
}

/* ===================== Выпуск билетов ===================== */

function tkStartBatch_(chatId, member, showCode, type, count, preview) {
  const show = tkShow_(showCode);
  if (!show) return tkSend_(chatId, 'Показ ' + tkEsc_(showCode) + ' не найден.');
  if (!TK_TYPES[type]) type = 'regular';
  if (!(count >= 1)) return tkSend_(chatId, 'Нужно число от 1.');
  if (count > TK.MAX_BATCH) return tkSend_(chatId, 'За один раз — не больше ' + TK.MAX_BATCH + ' билетов.');
  if (!show.tpl) return tkSend_(chatId, '⚠️ У показа нет макета. Добавьте ссылку на презентацию-макет в колонку «Макет» листа «Показы».');
  tkSend_(chatId, '⏳ Готовлю ' + count + ' (' + TK_TYPES[type].label + ') на ' + tkEsc_(tkShowLabel_(show)) + '. Пришлю PDF через минуту-другую.');
  return tkEnqueue_({ kind: 'batch', chatId: chatId, show: show.code, type: type, count: count, by: member.name });
}

function tkEnqueue_(job) {
  const props = PropertiesService.getScriptProperties();
  const lock = tkLock_();
  lock.waitLock(15000);
  try {
    const jobs = JSON.parse(props.getProperty('TK_JOBS') || '[]');
    jobs.push(job);
    props.setProperty('TK_JOBS', JSON.stringify(jobs));
  } finally {
    lock.releaseLock();
  }
  const has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'tkRunJobs'; });
  if (!has) ScriptApp.newTrigger('tkRunJobs').timeBased().after(1000).create();
}

function tkTemplateId_(url) {
  const m = String(url).match(/\/d\/([a-zA-Z0-9_-]{20,})/) || String(url).match(/^([a-zA-Z0-9_-]{20,})$/);
  if (!m) throw new Error('Не понимаю ссылку на макет: ' + url);
  return m[1];
}

/** Сколько билетов на листе в макете (по меткам {{QR_n}}). Быстрая подсказка — 6, если макет недоступен. */
function tkPerPageHint_(show) {
  try {
    const pres = SlidesApp.openById(tkTemplateId_(show.tpl));
    return tkSlots_(pres.getSlides()[0]).count || 6;
  } catch (err) {
    return 6;
  }
}

/** Все фигуры слайда, включая вложенные в группы. */
function tkShapes_(slide) {
  const out = [];
  const walk = function (els) {
    els.forEach(function (el) {
      const t = el.getPageElementType();
      if (t === SlidesApp.PageElementType.GROUP) walk(el.asGroup().getChildren());
      else if (t === SlidesApp.PageElementType.SHAPE) out.push(el.asShape());
    });
  };
  walk(slide.getPageElements());
  return out;
}

/** Метки QR на слайде: { count, qr: {1: shape, 2: shape, …} } */
function tkSlots_(slide) {
  const qr = {};
  let count = 0;
  tkShapes_(slide).forEach(function (sh) {
    let txt = '';
    try { txt = sh.getText().asString().trim(); } catch (err) { return; }
    const m = txt.match(/^\{\{QR_(\d+)\}\}$/);
    if (m) {
      qr[Number(m[1])] = sh;
      count = Math.max(count, Number(m[1]));
    }
  });
  return { count: count, qr: qr };
}

function tkFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('TK_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) { /* папку удалили — создадим новую */ }
  }
  const f = DriveApp.createFolder(TK.FOLDER_NAME);
  props.setProperty('TK_FOLDER_ID', f.getId());
  return f;
}

function tkRunJob_(job) {
  const show = tkShow_(job.show);
  if (!show) throw new Error('Показ ' + job.show + ' не найден.');
  const tplId = tkTemplateId_(show.tpl);
  let tplPres;
  try {
    tplPres = SlidesApp.openById(tplId);
  } catch (err) {
    throw new Error('не открывается макет показа ' + show.code + '. Проверьте ссылку в колонке «Макет» и что презентация лежит на вашем Диске.');
  }
  const per = tkSlots_(tplPres.getSlides()[0]).count;
  if (!per) throw new Error('В макете нет меток {{QR_1}}, {{QR_2}}… — бот не знает, куда ставить QR-коды.');

  const type = TK_TYPES[job.type] || TK_TYPES.regular;
  const price = show[type.price];
  const total = job.kind === 'preview' ? per : Math.ceil(job.count / per) * per;
  const batch = Utilities.formatDate(new Date(), TK.TZ, 'yyMMdd-HHmm') + '-' + show.code;

  // 1. коды
  let codes = [];
  if (job.kind === 'preview') {
    for (let i = 0; i < total; i++) codes.push(tkRandomCode_());
  } else {
    const lock = tkLock_();
    lock.waitLock(30000);
    try {
      const sh = tkSheet_(TK.SHEET_TICKETS);
      const last = sh.getLastRow();
      const taken = {};
      if (last >= 2) sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) { taken[String(r[0])] = 1; });
      while (codes.length < total) {
        const c = tkRandomCode_();
        if (!taken[c]) { taken[c] = 1; codes.push(c); }
      }
      const now = new Date();
      const rows = codes.map(function (c) { return [c, show.code, type.label, price, TK.STATUS.NEW, batch, now, '', '', '', '']; });
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    } finally {
      lock.releaseLock();
    }
  }

  // 2. картинки QR
  const blobs = tkQrBlobs_(codes);

  // 3. PDF по макету
  const folder = tkFolder_();
  const title = (job.kind === 'preview' ? 'Образец · ' : 'Билеты · ') + tkShowLabel_(show) + ' · ' + type.label + ' · ' + batch;
  const copy = DriveApp.getFileById(tplId).makeCopy(title, folder);
  let pdf;
  try {
    const pres = SlidesApp.openById(copy.getId());
    const base = pres.getSlides()[0];
    pres.getSlides().slice(1).forEach(function (s) { s.remove(); });
    const pages = Math.ceil(codes.length / per);
    const common = {
      '{{СПЕКТАКЛЬ}}': show.title,
      '{{ДАТА}}': show.date,
      '{{ВРЕМЯ}}': show.time,
      '{{ПЛОЩАДКА}}': show.venue,
      '{{АДРЕС}}': show.addr,
      '{{ВОЗРАСТ}}': show.age,
      '{{ТИП}}': type.label,
      '{{ЦЕНА}}': tkMoney_(price),
    };
    for (let p = pages - 1; p >= 0; p--) { // дубли встают сразу за образцом, поэтому идём с конца
      const slide = base.duplicate();
      // пустой адрес — убираем и разделитель перед ним
      if (!show.addr) [' · {{АДРЕС}}', ', {{АДРЕС}}', '{{АДРЕС}}'].forEach(function (k) { slide.replaceAllText(k, ''); });
      Object.keys(common).forEach(function (k) { slide.replaceAllText(k, common[k]); });
      const slots = tkSlots_(slide);
      for (let i = 1; i <= per; i++) {
        const k = p * per + i - 1;
        slide.replaceAllText('{{КОД_' + i + '}}', job.kind === 'preview' ? 'ОБРАЗЕЦ' : tkPretty_(codes[k]));
        if (slots.qr[i]) slots.qr[i].replaceWithImage(blobs[k]);
      }
    }
    base.remove();
    pres.saveAndClose();
    pdf = DriveApp.getFileById(copy.getId()).getAs('application/pdf').setName(title + '.pdf');
    folder.createFile(pdf);
  } finally {
    copy.setTrashed(true);
  }

  const caption = job.kind === 'preview'
    ? '🧪 Образец по макету: ' + tkEsc_(tkShowLabel_(show)) + '. Коды на нём ненастоящие, в системе их нет.'
    : '🖨 ' + codes.length + ' билетов · ' + type.label + ' · ' + tkEsc_(tkShowLabel_(show)) +
      (codes.length > job.count ? '\n(округлил до целых листов: просили ' + job.count + ')' : '') +
      '\nПартия <code>' + batch + '</code>. Билеты в системе со статусом «создан» — продаются сканом в режиме «Продажа».';
  const res = tkSendDocument_(job.chatId, pdf, caption);
  if (!res.ok) throw new Error('Телеграм не принял PDF: ' + (res.description || '') + '. Файл сохранён в папке «' + TK.FOLDER_NAME + '».');
}

/** QR-картинки для кодов (порядок сохраняется). */
function tkQrBlobs_(codes) {
  const out = [];
  for (let i = 0; i < codes.length; i += 30) {
    const chunk = codes.slice(i, i + 30);
    const res = UrlFetchApp.fetchAll(chunk.map(function (c) {
      return { url: TK.QR_URL + encodeURIComponent(TK.QR_PREFIX + c), muteHttpExceptions: true };
    }));
    res.forEach(function (r, j) {
      if (r.getResponseCode() !== 200) throw new Error('Генератор QR не ответил (' + r.getResponseCode() + ') для ' + chunk[j]);
      out.push(r.getBlob().setName(chunk[j] + '.png'));
    });
  }
  return out;
}
