// Минимальная имитация Apps Script для проверки Билеты.gs в Node.
const crypto = require('crypto');

const toSigned = (buf) => Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
const toBuf = (arr) => Buffer.from(arr.map((b) => (b + 256) % 256));

function fmtDate(d, tz, pattern) {
  const parts = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    .formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
  return pattern.replace('yyyy', parts.year).replace('yy', parts.year.slice(2)).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour === '24' ? '00' : parts.hour).replace('mm', parts.minute).replace('ss', parts.second);
}

class Range {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.sheet.get(this.r + i, this.c + j)); out.push(row); } return out; }
  getDisplayValues() { return this.getValues().map((r) => r.map((v) => (v instanceof Date ? fmtDate(v, 'Europe/Belgrade', 'dd.MM.yyyy HH:mm:ss') : String(v)))); }
  setValues(v) { if (v.length !== this.nr || v.some((x) => x.length !== this.nc)) throw new Error('setValues size mismatch'); v.forEach((row, i) => row.forEach((x, j) => this.sheet.set(this.r + i, this.c + j, x))); return this; }
  setValue(x) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet.set(this.r + i, this.c + j, x); return this; }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
  getRow() { return this.r; }
  createTextFinder(text) {
    const self = this; let entire = false;
    return {
      matchEntireCell(b) { entire = b; return this; },
      findNext() {
        for (let i = 0; i < self.nr; i++) for (let j = 0; j < self.nc; j++) {
          const v = String(self.sheet.get(self.r + i, self.c + j));
          if (entire ? v === text : v.includes(text)) return new Range(self.sheet, self.r + i, self.c + j, 1, 1);
        }
        return null;
      },
    };
  }
}

class Sheet {
  constructor(name) { this.name = name; this.rows = []; }
  get(r, c) { const row = this.rows[r - 1]; const v = row ? row[c - 1] : undefined; return v === undefined ? '' : v; }
  set(r, c, v) { while (this.rows.length < r) this.rows.push([]); this.rows[r - 1][c - 1] = v; }
  getLastRow() { for (let i = this.rows.length; i > 0; i--) if ((this.rows[i - 1] || []).some((v) => v !== '' && v !== undefined)) return i; return 0; }
  getRange(a, b, c, d) {
    if (typeof a === 'string') { const m = a.match(/^([A-Z]):([A-Z])$/); const c1 = m[1].charCodeAt(0) - 64, c2 = m[2].charCodeAt(0) - 64; return new Range(this, 1, c1, Math.max(1, this.getLastRow()), c2 - c1 + 1); }
    return new Range(this, a, b, c || 1, d || 1);
  }
  appendRow(row) { const r = this.getLastRow() + 1; row.forEach((v, j) => this.set(r, j + 1, v)); }
  setFrozenRows() {}
  getName() { return this.name; }
}

function install() {
  const g = globalThis;
  const state = { sheets: {}, props: {}, cache: {}, triggers: [], tg: [], fetchAll: 0, files: {}, logs: [], tgResults: {} };
  g.__state = state;
  const ss = {
    getSheetByName: (n) => state.sheets[n] || null,
    insertSheet: (n) => (state.sheets[n] = new Sheet(n)),
    getId: () => 'SS',
  };
  g.SpreadsheetApp = { getActive: () => ss };
  g.PropertiesService = { getScriptProperties: () => ({
    getProperty: (k) => (k in state.props ? state.props[k] : null),
    setProperty: (k, v) => { state.props[k] = String(v); },
    deleteProperty: (k) => { delete state.props[k]; },
  }) };
  g.CacheService = { getScriptCache: () => ({
    get: (k) => (k in state.cache ? state.cache[k] : null), put: (k, v) => { state.cache[k] = v; }, remove: (k) => { delete state.cache[k]; },
  }) };
  const lock = { tryLock: () => true, waitLock: () => {}, releaseLock: () => {} };
  g.LockService = { getDocumentLock: () => lock, getScriptLock: () => lock };
  g.Utilities = {
    formatDate: fmtDate,
    getUuid: () => crypto.randomUUID(),
    newBlob: (s) => ({ getBytes: () => toSigned(Buffer.from(String(s), 'utf8')) }),
    computeHmacSha256Signature: (value, key) => toSigned(crypto.createHmac('sha256', toBuf(key)).update(toBuf(value)).digest()),
  };
  g.ContentService = { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ content: s, setMimeType() { return this; } }) };
  g.ScriptApp = {
    getProjectTriggers: () => state.triggers,
    deleteTrigger: (t) => { state.triggers = state.triggers.filter((x) => x !== t); },
    newTrigger: (fn) => ({ timeBased: () => ({ after: () => ({ create: () => { const t = { getHandlerFunction: () => fn }; state.triggers.push(t); return t; } }) }) }),
  };
  g.UrlFetchApp = {
    fetch: (url, opts) => {
      const method = url.split('/').pop();
      const payload = typeof opts.payload === 'string' ? JSON.parse(opts.payload) : opts.payload;
      state.tg.push({ method, payload });
      let result = true;
      if (method === 'getMe') result = { username: 'myxa_tickets_bot' };
      if (method === 'sendMessage') result = { message_id: state.tg.length };
      if (state.tgResults[method]) return { getContentText: () => JSON.stringify(state.tgResults[method]) };
      return { getContentText: () => JSON.stringify({ ok: true, result }) };
    },
    fetchAll: (reqs) => { state.fetchAll += reqs.length; return reqs.map((r) => ({ getResponseCode: () => 200, getBlob: () => ({ kind: 'png', url: r.url, setName(n) { this.name = n; return this; } }) })); },
  };
  // Презентации и Диск
  let fileSeq = 0;
  const makeShape = (text) => ({
    text, replacedWith: null,
    getPageElementType: () => 'SHAPE', asShape() { return this; },
    getText() { const s = this; return { asString: () => s.text + '\n' }; },
    replaceWithImage(blob) { this.replacedWith = blob; this.text = ''; return {}; },
  });
  const makeSlide = (shapes, pres) => {
    const slide = {
      shapes, pres, replaced: [],
      getPageElements: () => slide.shapes,
      duplicate() {
        const copy = makeSlide(slide.shapes.map((s) => makeShape(s.text)), pres);
        pres.slides.splice(pres.slides.indexOf(slide) + 1, 0, copy);
        return copy;
      },
      replaceAllText(find, rep) { slide.replaced.push([find, rep]); slide.shapes.forEach((s) => { s.text = s.text.split(find).join(rep); }); return 1; },
      remove() { pres.slides.splice(pres.slides.indexOf(slide), 1); },
    };
    return slide;
  };
  g.__makeTemplate = (perPage, extraSlides) => {
    const id = 'TPL' + 'x'.repeat(30);
    const shapes = [makeShape('{{СПЕКТАКЛЬ}}'), makeShape('{{ДАТА}} · {{ВРЕМЯ}}'), makeShape('{{ПЛОЩАДКА}} · {{АДРЕС}}'), makeShape('{{ВОЗРАСТ}}'), makeShape('{{ТИП}} · {{ЦЕНА}} дин.')];
    for (let i = 1; i <= perPage; i++) { shapes.push(makeShape('{{QR_' + i + '}}')); shapes.push(makeShape('{{КОД_' + i + '}}')); }
    const pres = { slides: [], saved: false };
    pres.slides.push(makeSlide(shapes, pres));
    for (let k = 0; k < (extraSlides || 0); k++) pres.slides.push(makeSlide([makeShape('инструкция')], pres));
    state.files[id] = { pres };
    return id;
  };
  g.SlidesApp = {
    PageElementType: { SHAPE: 'SHAPE', GROUP: 'GROUP' },
    openById: (id) => {
      const f = state.files[id]; if (!f) throw new Error('no file ' + id);
      const pres = f.pres;
      return { getSlides: () => pres.slides.slice(), saveAndClose: () => { pres.saved = true; } };
    },
  };
  const folder = { id: 'FOLDER', getId: () => 'FOLDER', created: [], createFile(b) { this.created.push(b); } };
  state.folder = folder;
  g.DriveApp = {
    createFolder: () => folder,
    getFolderById: () => folder,
    getFileById: (id) => ({
      makeCopy: (title) => {
        const src = state.files[id].pres;
        const nid = 'COPY' + ++fileSeq;
        const pres = { slides: [], saved: false };
        src.slides.forEach((s) => pres.slides.push(makeSlide(s.shapes.map((x) => makeShape(x.text)), pres)));
        state.files[nid] = { pres, title, trashed: false };
        return { getId: () => nid, setTrashed: (b) => { state.files[nid].trashed = b; } };
      },
      getAs: () => ({ kind: 'pdf', fromId: id, setName(n) { this.name = n; return this; } }),
    }),
  };
  g.console = Object.assign(Object.create(console), { log: (...a) => state.logs.push(a.join(' ')), error: (...a) => state.logs.push('ERR ' + a.join(' ')) });
  return state;
}

// Подпись initData как у Telegram
function initData(token, user, authDate) {
  const fields = { auth_date: String(authDate || Math.floor(Date.now() / 1000)), query_id: 'AAE1', user: JSON.stringify(user) };
  const dcs = Object.keys(fields).sort().map((k) => k + '=' + fields[k]).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return Object.keys(fields).map((k) => k + '=' + encodeURIComponent(fields[k])).join('&') + '&hash=' + hash;
}

module.exports = { install, initData, Sheet };
