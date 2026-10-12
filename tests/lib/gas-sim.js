'use strict';
/**
 * Apps Script 모의 실행 환경 (tests/sim.test.js에서 사용)
 *
 * - src/*.gs를 Apps Script 편집기의 순서대로 이어 붙여 하나의 node:vm 컨텍스트에서 실행한다
 *   (Apps Script처럼 모든 파일이 전역 범위를 함께 쓴다).
 * - 트리거 실행 한 번 = 새 컨텍스트 한 번. 시트·스크립트 속성·캘린더·보낸 메일은 World에 남는다.
 *   (Store가 실행마다 시트를 한 번만 읽고 캐시하므로, 실행을 나누지 않으면 실제와 다르게 동작한다.)
 * - Date.now()는 World의 가짜 시계를 따른다.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// SIM_SRC_DIR로 다른 소스 폴더(예: 수정안 사본)를 지정할 수 있다
const SRC_DIR = process.env.SIM_SRC_DIR ? path.resolve(process.env.SIM_SRC_DIR) : path.join(__dirname, '..', '..', 'src');
const SRC_ORDER = ['Config.gs', 'Rules.gs', 'Store.gs', 'Sync.gs', 'Notify.gs', 'Report.gs', 'Setup.gs'];

const KST_OFFSET = 9 * 3600 * 1000;

/** 'YYYY-MM-DDTHH:MM' 또는 'YYYY-MM-DDTHH:MM:SS' (한국 시각) → epoch ms */
function kst(s) {
  if (typeof s === 'number') return s;
  const ms = Date.parse(s + '+09:00');
  if (isNaN(ms)) throw new Error('kst(): 잘못된 시각 ' + s);
  return ms;
}
const isoKst = ms => new Date(ms + KST_OFFSET).toISOString().replace(/\.\d{3}Z$/, '+09:00');
const isoUtc = ms => new Date(ms).toISOString();
const dateKst = ms => new Date(ms + KST_OFFSET).toISOString().slice(0, 10);
const isDate = v => Object.prototype.toString.call(v) === '[object Date]';
const clone = o => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

// ---------------------------------------------------------------- bundle
const BUNDLES = {};
let BUNDLE = null;
/** order: 'editor'(편집기 순서) | 'alpha'(clasp처럼 이름순). dir: 다른 소스 폴더(예: 운영본 src, 없으면 SRC_DIR) */
function bundle(order, dir) {
  order = order || 'editor';
  const srcDir = dir ? path.resolve(dir) : SRC_DIR;
  const key = order + '|' + srcDir;
  if (BUNDLES[key]) return (BUNDLE = BUNDLES[key]);
  let code = '';
  const map = [];
  let line = 1;
  const files = order === 'alpha' ? SRC_ORDER.slice().sort() : SRC_ORDER;
  for (const f of files) {
    const src = fs.readFileSync(path.join(srcDir, f), 'utf8');
    map.push({ file: f, start: line, lines: src.split('\n').length });
    code += src + '\n';
    line += src.split('\n').length;
  }
  BUNDLE = BUNDLES[key] = { script: new vm.Script(code, { filename: 'gas-bundle.js' }), map };
  return BUNDLE;
}

/** 'gas-bundle.js:123:4' → 'Sync.gs:45:4' */
function mapStack(text) {
  const { map } = bundle();
  return String(text).replace(/gas-bundle\.js:(\d+)(?::(\d+))?/g, (m, l, c) => {
    l = Number(l);
    for (let i = map.length - 1; i >= 0; i--) {
      if (l >= map[i].start) return map[i].file + ':' + (l - map[i].start + 1) + (c ? ':' + c : '');
    }
    return m;
  });
}

// ---------------------------------------------------------------- Spreadsheet
const EMPTY = '';
const isEmptyStored = v => v === '' || v === null || v === undefined;

function colToNum(s) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }

class MockRange {
  constructor(sheet, row, col, nr, nc) {
    if (!(row >= 1 && col >= 1)) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    if (!(nr >= 1)) throw new Error('The number of rows in the range must be at least 1.');
    if (!(nc >= 1)) throw new Error('The number of columns in the range must be at least 1.');
    Object.assign(this, { sheet, row, col, nr, nc });
  }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.nr; }
  getNumColumns() { return this.nc; }
  getLastRow() { return this.row + this.nr - 1; }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const row = [];
      for (let c = 0; c < this.nc; c++) row.push(this.sheet._get(this.row + r, this.col + c));
      out.push(row);
    }
    return out;
  }
  getValue() { return this.sheet._get(this.row, this.col); }
  setValues(values) {
    if (!Array.isArray(values)) throw new Error('Exception: The parameters (String) don\'t match the method signature for SpreadsheetApp.Range.setValues.');
    if (values.length !== this.nr) {
      throw new Error('Exception: The number of rows in the data does not match the number of rows in the range. The data has ' +
        values.length + ' but the range has ' + this.nr + '.');
    }
    values.forEach((row, r) => {
      if (!Array.isArray(row) || row.length !== this.nc) {
        throw new Error('Exception: The number of columns in the data does not match the number of columns in the range. The data has ' +
          (row && row.length) + ' but the range has ' + this.nc + '.');
      }
      row.forEach((v, c) => this.sheet._set(this.row + r, this.col + c, v));
    });
    return this;
  }
  setValue(v) { this.sheet._set(this.row, this.col, v); return this; }
  /** Range.sort({column, ascending}) — 범위 안의 행을 그 열로 정렬(같은 값은 순서 유지) */
  sort(spec) {
    const col = typeof spec === 'number' ? spec : spec.column;
    const asc = typeof spec === 'number' ? true : spec.ascending !== false;
    const val = v => (v && typeof v === 'object' && v.t === 'd' ? v.ms : v === '' || v === undefined ? null : v);
    const rows = [];
    for (let r = 0; r < this.nr; r++) {
      const row = this.sheet.cells[this.row - 1 + r] || [];
      rows.push({ i: r, cells: row.slice(this.col - 1, this.col - 1 + this.nc), key: val(row[col - 1]) });
    }
    rows.sort((a, b) => {
      if (a.key === b.key) return a.i - b.i;
      if (a.key === null) return 1;
      if (b.key === null) return -1;
      return (a.key < b.key ? -1 : 1) * (asc ? 1 : -1);
    });
    rows.forEach((x, r) => {
      while (this.sheet.cells.length < this.row + r) this.sheet.cells.push([]);
      const target = this.sheet.cells[this.row - 1 + r];
      x.cells.forEach((v, c) => { while (target.length < this.col + c) target.push(''); target[this.col - 1 + c] = v; });
    });
    return this;
  }
  clearContent() {
    for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) this.sheet._set(this.row + r, this.col + c, '');
    return this;
  }
}
// 표시 형식 '@'(일반 텍스트) 열은 문자열을 숫자로 바꾸지 않는다. 나머지 서식은 값에 영향이 없다.
MockRange.prototype.setNumberFormat = function (f) {
  this.sheet.formatCalls.push('setNumberFormat');
  for (let c = this.col; c < this.col + this.nc; c++) {
    if (f === '@') this.sheet.textCols.add(c); else this.sheet.textCols.delete(c);
  }
  return this;
};
['setNumberFormats', 'setFontWeight', 'setFontWeights', 'setBackground', 'setFontColor',
  'setWrap', 'setHorizontalAlignment', 'setVerticalAlignment', 'setFontSize', 'setBorder', 'setNote']
  .forEach(m => { MockRange.prototype[m] = function () { this.sheet.formatCalls.push(m); return this; }; });

class MockSheet {
  constructor(ss, name) {
    this.ss = ss;
    this.name = name;
    this.cells = []; // cells[r-1][c-1] = 저장값(문자열·숫자·불리언·{t:'d',ms}·'')
    this.formatCalls = [];
    this.frozenRows = 0;
    this.textCols = new Set();
    this.maxRows = 1000;      // 새 시트의 기본 칸 수(실제 Sheets와 같음). getRange는 칸을 늘려 주지 않는다
    this.readCalls = 0;
    this.hidden = new Set();  // 숨긴 열(1부터)
    this.cfRules = [];        // 조건부 서식 규칙
  }
  getConditionalFormatRules() { return this.cfRules.slice(); }
  setConditionalFormatRules(rules) { this.cfRules = rules.slice(); return this; }
  deleteRow(r) {
    if (r < 1 || r > this.maxRows) throw new Error('Those rows are out of bounds.');
    this.cells.splice(r - 1, 1);
    this.maxRows--;
    return this;
  }
  getName() { return this.name; }
  /** Sheet.copyTo(spreadsheet): 값·서식을 복사한 새 시트(이름 'Copy of …'). 보호는 복사하지 않는다 */
  copyTo(ss) {
    const s = new MockSheet(ss, 'Copy of ' + this.name);
    s.cells = this.cells.map(r => r.slice());
    s.textCols = new Set(this.textCols);
    s.hidden = new Set(this.hidden);
    s.maxRows = this.maxRows;
    s.frozenRows = this.frozenRows;
    s.cfRules = this.cfRules.slice();
    ss.sheets.push(s);
    return s;
  }
  hideColumns(c, n) { for (let i = c; i < c + (n || 1); i++) this.hidden.add(i); return this; }
  showColumns(c, n) { for (let i = c; i < c + (n || 1); i++) this.hidden.delete(i); return this; }
  isColumnHiddenByUser(c) { return this.hidden.has(c); }
  setName(n) { this.name = n; return this; }
  protect() {
    const p = {
      description: '', editors: ['other@example.com'], domainEdit: true,
      setDescription(d) { this.description = d; return this; },
      getEditors() { return this.editors.map(e => ({ getEmail: () => e })); },
      removeEditors(list) { const rm = list.map(u => u.getEmail()); this.editors = this.editors.filter(e => rm.indexOf(e) < 0); return this; },
      canDomainEdit() { return this.domainEdit; },
      setDomainEdit(v) { this.domainEdit = v; return this; }
    };
    (this.protections = this.protections || []).push(p);
    return p;
  }
  getProtections() { return (this.protections || []).slice(); }
  getLastRow() {
    for (let r = this.cells.length; r >= 1; r--) if ((this.cells[r - 1] || []).some(v => !isEmptyStored(v))) return r;
    return 0;
  }
  getLastColumn() {
    let m = 0;
    for (const row of this.cells) for (let c = row.length; c >= 1; c--) if (!isEmptyStored(row[c - 1])) { m = Math.max(m, c); break; }
    return m;
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return 26; }
  getDataRange() { this.readCalls++; return new MockRange(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  getRange(a, b, c, d) {
    const r = this._getRange(a, b, c, d);
    if (r.row + r.nr - 1 > this.maxRows) throw new Error('Exception: The coordinates of the range are outside the dimensions of the sheet.');
    return r;
  }
  insertRowsAfter(after, n) { this.maxRows += n; return this; }
  _getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const m = /^([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/.exec(a.trim());
      if (!m) throw new Error('Range not found');
      const c1 = colToNum(m[1]), r1 = m[2] ? Number(m[2]) : 1;
      const c2 = m[3] ? colToNum(m[3]) : c1;
      const r2 = m[4] ? Number(m[4]) : (m[2] && !m[3] ? r1 : this.getMaxRows());
      return new MockRange(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
    }
    return new MockRange(this, a, b, c === undefined ? 1 : c, d === undefined ? 1 : d);
  }
  appendRow(values) {
    if (!Array.isArray(values)) throw new Error('Exception: The parameters don\'t match the method signature for SpreadsheetApp.Sheet.appendRow.');
    const r = this.getLastRow() + 1;
    if (r > this.maxRows) this.maxRows = r; // appendRow는 칸을 늘린다
    for (let c = 0; c < values.length; c++) this._set(r, c + 1, values[c] === undefined ? '' : values[c]);
    if (!values.length) this._set(r, 1, '');
    return this;
  }
  setFrozenRows(n) { this.frozenRows = n; return this; }
  setColumnWidth() { return this; }
  setColumnWidths() { return this; }
  autoResizeColumns() { return this; }
  clear() { this.cells = []; return this; }

  _set(r, c, v) {
    while (this.cells.length < r) this.cells.push([]);
    const row = this.cells[r - 1];
    while (row.length < c) row.push('');
    row[c - 1] = this.textCols.has(c) && typeof v === 'string' ? v : this.ss.world.toStored(v);
  }
  _get(r, c) {
    const row = this.cells[r - 1];
    const v = row && c - 1 < row.length ? row[c - 1] : '';
    return this.ss.world.toCell(v);
  }
}

class MockSpreadsheet {
  constructor(world) {
    this.world = world;
    this.sheets = [new MockSheet(this, 'Sheet1')];
    this.timeZone = 'America/Los_Angeles';
    this.id = 'MOCK_SPREADSHEET_ID';
  }
  getId() { return this.id; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit'; }
  getName() { return '장비 예약 기록'; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  getSheets() { return this.sheets.slice(); }
  getActiveSheet() { return this.active && this.sheets.indexOf(this.active) >= 0 ? this.active : this.sheets[0] || null; }
  setActiveSheet(s) { this.active = s; return s; }
  /** 선택한 시트를 pos번째(1부터) 탭으로 옮긴다 */
  moveActiveSheet(pos) {
    const s = this.getActiveSheet();
    this.sheets = this.sheets.filter(x => x !== s);
    this.sheets.splice(Math.max(0, Math.min(pos - 1, this.sheets.length)), 0, s);
  }
  insertSheet(n) {
    if (this.getSheetByName(n)) throw new Error('A sheet with the name "' + n + '" already exists. Please enter another name.');
    const s = new MockSheet(this, n);
    this.sheets.push(s);
    return s;
  }
  deleteSheet(s) {
    if (this.sheets.length <= 1) throw new Error('You can\'t remove all the sheets in a document.');
    this.sheets = this.sheets.filter(x => x !== s);
  }
  setSpreadsheetTimeZone(tz) { this.timeZone = tz; }
  getSpreadsheetTimeZone() { return this.timeZone; }
}

// ---------------------------------------------------------------- Calendar
const B32 = '0123456789abcdefghijklmnopqrstuv';

class MockCalendar {
  constructor(world) {
    this.world = world;
    this.cals = new Map();
    this.seq = 0;
    this.idn = 0;
    this.pages = new Map();
    this.pageN = 0;
    this.calls = [];
  }
  addCalendar(id, summary, opts = {}) {
    this.cals.set(id, Object.assign({
      id, summary, events: new Map(), epoch: 1,
      failWith: null,            // Events.list가 던질 오류 메시지
      deletedForm: 'minimal+updated', // 'minimal+updated' | 'minimal' | 'idOnly' | 'full'
      purgeDeletedOnFullList: false,  // 전체 목록에서 지운 일정이 이미 사라졌는지(오래된 삭제)
      getDeleted: 'minimal',          // Events.get으로 지운 일정을 읽을 때: 'minimal'(id·status) | 'full' | 'notFound'
      accessRole: 'reader'
    }, opts));
  }
  cal(id) {
    const c = this.cals.get(id);
    if (!c) throw new Error('mock: 알 수 없는 캘린더 ' + id);
    return c;
  }
  newId() {
    // 실제 UI에서 만든 일정 ID처럼 base32hex 소문자 26자(숫자만으로 된 ID는 아님)
    const n = ++this.idn;
    return ('k' + n.toString(32).padStart(6, '0') + 'h7mq2c9r1v0t4pl8sd3gfbaa').slice(0, 26);
  }
  touch(ev) {
    ev._seq = ++this.seq;
    ev.updated = isoUtc(this.world.now);
    ev.etag = '"' + (3500000000000000 + ev._seq) + '"';
  }
  timeObj(ms, allDay) {
    return allDay ? { date: dateKst(ms) } : { dateTime: isoKst(ms), timeZone: 'Asia/Seoul' };
  }
  /** 일정 만들기. start/end: KST 문자열 또는 ms. 반환: 일정 ID */
  create(calId, o) {
    const cal = this.cal(calId);
    const id = o.id || this.newId();
    if (cal.events.has(id)) throw new Error('mock: 이미 있는 ID ' + id);
    const start = kst(o.start), end = kst(o.end);
    const ev = {
      kind: 'calendar#event', id, status: 'confirmed',
      htmlLink: 'https://www.google.com/calendar/event?eid=' + id,
      created: isoUtc(o.created != null ? kst(o.created) : this.world.now),
      summary: o.summary,
      creator: { email: o.creator || 'labuser@example.com' },
      organizer: { email: calId, displayName: cal.summary, self: true },
      start: this.timeObj(start, o.allDay), end: this.timeObj(end, o.allDay),
      iCalUID: (o.recurringEventId || id) + '@google.com', sequence: 0,
      reminders: { useDefault: true }, eventType: 'default'
    };
    if (o.summary === undefined) delete ev.summary;
    if (o.recurringEventId) {
      ev.recurringEventId = o.recurringEventId;
      ev.originalStartTime = this.timeObj(start, o.allDay);
    }
    this.touch(ev);
    cal.events.set(id, ev);
    return id;
  }
  /** 반복 일정(singleEvents=true로 펼친 인스턴스만 모델링) */
  createRecurring(calId, o, starts) {
    const base = o.id || this.newId();
    const dur = kst(o.end) - kst(o.start);
    return starts.map(s => {
      const st = kst(s);
      const suffix = new Date(st).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      return this.create(calId, Object.assign({}, o, { id: base + '_' + suffix, start: st, end: st + dur, recurringEventId: base }));
    });
  }
  get(calId, id) {
    const ev = this.cal(calId).events.get(id);
    if (!ev) throw new Error('mock: 없는 일정 ' + id);
    return ev;
  }
  patch(calId, id, ch) {
    const ev = this.get(calId, id);
    if ('summary' in ch) ev.summary = ch.summary;
    const allDay = !!ch.allDay;
    if (ch.start !== undefined || ch.allDay) {
      const st = ch.start !== undefined ? kst(ch.start) : Date.parse(ev.start.dateTime || ev.start.date);
      ev.start = this.timeObj(st, allDay);
      ev.sequence++;
    }
    if (ch.end !== undefined || ch.allDay) {
      const en = ch.end !== undefined ? kst(ch.end) : Date.parse(ev.end.dateTime || ev.end.date);
      ev.end = this.timeObj(en, allDay);
      ev.sequence++;
    }
    this.touch(ev);
  }
  remove(calId, id) { const ev = this.get(calId, id); ev.status = 'cancelled'; this.touch(ev); }
  restore(calId, id) { const ev = this.get(calId, id); ev.status = 'confirmed'; this.touch(ev); }
  /** events.move: 원래 캘린더에서는 cancelled, 새 캘린더에는 같은 ID로 나타난다(created 유지) */
  move(calId, id, destId) {
    const ev = this.get(calId, id);
    const copy = clone(ev);
    ev.status = 'cancelled';
    this.touch(ev);
    const dest = this.cal(destId);
    copy.status = 'confirmed';
    copy.organizer = { email: destId, displayName: dest.summary, self: true };
    this.touch(copy);
    dest.events.set(id, copy);
  }
  invalidateTokens(calId) { this.cal(calId).epoch++; }

  present(cal, ev) {
    const pub = clone(ev);
    delete pub._seq;
    if (ev.status !== 'cancelled' || cal.deletedForm === 'full') return pub;
    if (cal.deletedForm === 'idOnly') return { id: ev.id, status: 'cancelled' };
    const m = { kind: 'calendar#event', etag: ev.etag, id: ev.id, status: 'cancelled' };
    if (ev.recurringEventId) { m.recurringEventId = ev.recurringEventId; m.originalStartTime = clone(ev.originalStartTime); }
    if (cal.deletedForm === 'minimal+updated') m.updated = ev.updated;
    return m;
  }

  eventsList(calendarId, opts) {
    opts = opts || {};
    this.calls.push({ api: 'events.list', calendarId, opts: clone(opts), at: this.world.now });
    const cal = this.cals.get(calendarId);
    if (!cal) throw new Error('API call to calendar.events.list failed with error: Not Found');
    if (cal.failWith) throw new Error(cal.failWith);
    const allowed = ['alwaysIncludeEmail', 'eventTypes', 'iCalUID', 'maxAttendees', 'maxResults', 'orderBy', 'pageToken',
      'privateExtendedProperty', 'q', 'sharedExtendedProperty', 'showDeleted', 'showHiddenInvitations', 'singleEvents',
      'syncToken', 'timeMax', 'timeMin', 'timeZone', 'updatedMin', 'fields'];
    for (const k of Object.keys(opts)) {
      if (allowed.indexOf(k) < 0) throw new Error('API call to calendar.events.list failed with error: Invalid argument ' + k);
    }
    if (opts.syncToken) {
      for (const k of ['iCalUID', 'orderBy', 'privateExtendedProperty', 'q', 'sharedExtendedProperty', 'timeMin', 'timeMax', 'updatedMin']) {
        if (opts[k] != null) throw new Error('API call to calendar.events.list failed with error: Bad Request (' + k + ' with syncToken)');
      }
    }
    if (opts.orderBy === 'startTime' && !opts.singleEvents) {
      throw new Error('API call to calendar.events.list failed with error: The requested ordering is not available for the particular query.');
    }
    const max = Math.min(Number(opts.maxResults || 250), 2500);

    let page;
    if (opts.pageToken) {
      page = this.pages.get(opts.pageToken);
      if (!page) throw new Error('API call to calendar.events.list failed with error: Invalid page token');
    } else {
      let items;
      if (opts.syncToken) {
        const m = /^tok\|(.+)\|(\d+)\|(\d+)$/.exec(opts.syncToken);
        if (!m || m[1] !== calendarId || Number(m[2]) !== cal.epoch) {
          throw new Error('API call to calendar.events.list failed with error: Sync token is no longer valid, a full sync is required.');
        }
        const since = Number(m[3]);
        items = Array.from(cal.events.values()).filter(ev => ev._seq > since);
      } else {
        items = Array.from(cal.events.values()).filter(ev => {
          if (ev.status === 'cancelled') return !!opts.showDeleted && !cal.purgeDeletedOnFullList;
          return true;
        });
        const tmin = opts.timeMin ? Date.parse(opts.timeMin) : null;
        const tmax = opts.timeMax ? Date.parse(opts.timeMax) : null;
        const st = ev => Date.parse(ev.start ? ev.start.dateTime || ev.start.date : 0);
        const en = ev => Date.parse(ev.end ? ev.end.dateTime || ev.end.date : 0);
        if (tmin !== null) items = items.filter(ev => ev.status === 'cancelled' || en(ev) > tmin);
        if (tmax !== null) items = items.filter(ev => ev.status === 'cancelled' || st(ev) < tmax);
        if (opts.orderBy === 'startTime') items.sort((a, b) => st(a) - st(b));
      }
      page = { items: items.map(ev => this.present(cal, ev)), offset: 0, syncSeq: this.seq, epoch: cal.epoch };
    }
    const slice = page.items.slice(page.offset, page.offset + max);
    const resp = {
      kind: 'calendar#events', etag: '"p' + this.seq + '"', summary: cal.summary, updated: isoUtc(this.world.now),
      timeZone: 'Asia/Seoul', accessRole: cal.accessRole, defaultReminders: [], items: slice
    };
    if (page.offset + max < page.items.length) {
      const tok = 'pg' + (++this.pageN);
      this.pages.set(tok, Object.assign({}, page, { offset: page.offset + max }));
      resp.nextPageToken = tok;
    } else if (!opts.timeMax && !opts.orderBy) {
      // 전체 동기화는 timeMin과 함께여도 nextSyncToken을 준다(Apps Script 고급 캘린더 예제와 같음).
      // timeMax·orderBy가 있으면 주지 않는 것으로 단순화
      resp.nextSyncToken = 'tok|' + calendarId + '|' + page.epoch + '|' + page.syncSeq;
    }
    return resp;
  }

  service() {
    const self = this;
    return {
      Events: {
        list: (calendarId, opts) => self.eventsList(calendarId, opts),
        get: (calendarId, id) => {
          self.calls.push({ api: 'events.get', calendarId, id, at: self.world.now });
          const cal = self.cal(calendarId);
          const ev = cal.events.get(id);
          if (!ev || (ev.status === 'cancelled' && cal.getDeleted === 'notFound')) {
            throw new Error('API call to calendar.events.get failed with error: Not Found');
          }
          // getDeleted: 'full'이면 지운 일정도 updated까지 돌려준다
          if (ev.status === 'cancelled' && cal.getDeleted === 'full') { const pub = clone(ev); delete pub._seq; return pub; }
          return self.present(cal, ev);
        }
      },
      CalendarList: {
        get: (id) => {
          const c = self.cals.get(id);
          if (!c) throw new Error('API call to calendar.calendarList.get failed with error: Not Found');
          return { kind: 'calendar#calendarListEntry', id: c.id, summary: c.summary, accessRole: c.accessRole };
        },
        list: (opts) => {
          opts = opts || {};
          self.calls.push({ api: 'calendarList.list', opts: clone(opts) });
          const all = Array.from(self.cals.values()).map(c => ({
            kind: 'calendar#calendarListEntry', id: c.id, summary: c.summary, accessRole: c.accessRole,
            timeZone: 'Asia/Seoul'
          }));
          const max = Number(opts.maxResults || 100);
          const off = opts.pageToken ? Number(String(opts.pageToken).replace('cl', '')) : 0;
          const resp = { kind: 'calendar#calendarList', items: all.slice(off, off + max) };
          if (off + max < all.length) resp.nextPageToken = 'cl' + (off + max);
          return resp;
        }
      },
      Calendars: {
        get: (id) => {
          const c = self.cals.get(id);
          if (!c) throw new Error('API call to calendar.calendars.get failed with error: Not Found');
          return { kind: 'calendar#calendar', id: c.id, summary: c.summary, timeZone: 'Asia/Seoul' };
        }
      }
    };
  }
}

// ---------------------------------------------------------------- World
class World {
  constructor(opts = {}) {
    this.now = kst(opts.now || '2026-10-11T15:00');
    this.props = new Map();
    this.ss = new MockSpreadsheet(this);
    this.calendar = new MockCalendar(this);
    this.mails = [];
    this.execs = [];
    this.triggers = [];
    this.trigN = 0;
    this.configOverrides = opts.config || {};
    this.order = opts.order || process.env.SIM_ORDER || 'editor';
    this.srcDir = opts.srcDir || null;
    this.lockBusy = false;
    this.lockHeld = false;
    this.mailFail = null;
    this.quota = 1500;
    this.coerceStrings = true; // 시트가 숫자처럼 보이는 문자열을 숫자로 바꾸는 동작
    this.ctxDate = null;
    this.ctx = null;
  }
  at(s) { this.now = kst(s); return this; }

  // 시트 저장값 변환 ----------------------------------------------------
  toStored(v) {
    if (v === null || v === undefined) return '';
    if (isDate(v)) {
      const ms = v.getTime();
      if (isNaN(ms)) return '';
      return { t: 'd', ms };
    }
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      if (this.coerceStrings) {
        if (/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v)) return Number(Number(v).toPrecision(15));
        if (/^=/.test(v)) return '#NAME?';
      }
      return v;
    }
    throw new Error('Exception: 셀에 넣을 수 없는 값: ' + Object.prototype.toString.call(v));
  }
  toCell(v) {
    if (v && typeof v === 'object' && v.t === 'd') return new this.ctxDate(v.ms);
    return v;
  }

  // 실행 ---------------------------------------------------------------
  services(exec) {
    const world = this;
    const fmt = a => a.map(x => (typeof x === 'string' ? x : x instanceof Error || (x && x.stack) ? String(x) : JSON.stringify(x))).join(' ');
    const consoleMock = {
      log: (...a) => exec.logs.push(fmt(a)),
      info: (...a) => exec.logs.push(fmt(a)),
      warn: (...a) => exec.logs.push('WARN ' + fmt(a)),
      error: (...a) => exec.errors.push(fmt(a))
    };
    const MAIL_KEYS = ['to', 'cc', 'bcc', 'replyTo', 'subject', 'body', 'htmlBody', 'name', 'noReply', 'attachments', 'inlineImages'];
    const MailApp = {
      sendEmail(a, b, c, d) {
        const msg = a && typeof a === 'object' ? Object.assign({}, a) : Object.assign({ to: a, subject: b, body: c }, d || {});
        for (const k of Object.keys(msg)) if (MAIL_KEYS.indexOf(k) < 0) exec.warnings.push('MailApp.sendEmail: unknown option ' + k);
        if (world.mailFail) throw new Error(world.mailFail);
        if (!msg.to && !msg.cc && !msg.bcc) throw new Error('Exception: Failed to send email: no recipient');
        if (msg.subject === undefined || msg.body === undefined) throw new Error('Exception: Invalid argument: subject/body');
        const n = [msg.to, msg.cc, msg.bcc].filter(Boolean).join(',').split(',').filter(s => s.trim()).length;
        if (world.quota < n) throw new Error('Exception: Service invoked too many times for one day: email.');
        world.quota -= n;
        msg.at = world.now;
        msg.exec = exec.fn;
        world.mails.push(msg);
        exec.mails.push(msg);
      },
      getRemainingDailyQuota() { return world.quota; }
    };
    const PropertiesService = {
      getScriptProperties() {
        const p = {
          getProperty: k => (world.props.has(String(k)) ? world.props.get(String(k)) : null),
          setProperty: (k, v) => { world.props.set(String(k), String(v)); return p; },
          deleteProperty: k => { world.props.delete(String(k)); return p; },
          getProperties: () => Object.fromEntries(world.props),
          getKeys: () => Array.from(world.props.keys())
        };
        return p;
      }
    };
    const LockService = {
      getScriptLock() {
        return {
          tryLock: () => { if (world.lockBusy) return false; world.lockHeld = true; return true; },
          waitLock: () => {
            if (world.lockBusy) throw new Error('Exception: Lock timeout: another process was holding the lock for too long.');
            world.lockHeld = true;
          },
          releaseLock: () => { world.lockHeld = false; },
          hasLock: () => world.lockHeld
        };
      }
    };
    const WeekDay = {};
    ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].forEach(d => { WeekDay[d] = d; });
    const trigObj = t => ({
      getHandlerFunction: () => t.handler, getUniqueId: () => t.id, getEventType: () => t.type,
      getTriggerSource: () => t.source, getTriggerSourceId: () => t.sourceId || null
    });
    const ScriptApp = {
      WeekDay,
      EventType: { CLOCK: 'CLOCK', ON_EVENT_UPDATED: 'ON_EVENT_UPDATED' },
      getProjectTriggers: () => world.triggers.map(trigObj),
      deleteTrigger: t => { const id = t.getUniqueId(); world.triggers = world.triggers.filter(x => x.id !== id); },
      newTrigger(handler) {
        const spec = { handler, id: 'trg' + (++world.trigN) };
        const tb = {
          everyMinutes(n) {
            if ([1, 5, 10, 15, 30].indexOf(n) < 0) throw new Error('Exception: Invalid argument: minutes (' + n + ')');
            spec.everyMinutes = n; return tb;
          },
          everyHours(n) { spec.everyHours = n; return tb; },
          onWeekDay(d) { if (!WeekDay[d]) throw new Error('Exception: Invalid argument: weekDay'); spec.weekDay = d; return tb; },
          atHour(h) { if (!(h >= 0 && h <= 23)) throw new Error('Exception: Invalid argument: hour'); spec.atHour = h; return tb; },
          nearMinute(m) { spec.nearMinute = m; return tb; },
          inTimezone(tz) { spec.tz = tz; return tb; },
          create() {
            if (!spec.everyMinutes && !spec.everyHours && !spec.weekDay) throw new Error('Exception: trigger needs a schedule');
            spec.type = 'CLOCK'; spec.source = 'CLOCK';
            world.triggers.push(spec); return trigObj(spec);
          }
        };
        return {
          timeBased: () => tb,
          forUserCalendar: (calId) => ({
            onEventUpdated: () => ({
              create: () => {
                spec.type = 'ON_EVENT_UPDATED'; spec.source = 'CALENDAR'; spec.sourceId = calId;
                world.triggers.push(spec); return trigObj(spec);
              }
            })
          })
        };
      }
    };
    // 조건부 서식 규칙: { formula, background, fontColor, ranges } — 검사에서 그대로 읽는다
    const newConditionalFormatRule = () => {
      const r = { formula: null, background: null, fontColor: null, ranges: [] };
      const b = {
        whenFormulaSatisfied(f) { r.formula = f; return b; },
        setBackground(c) { r.background = c; return b; },
        setFontColor(c) { r.fontColor = c; return b; },
        setRanges(rs) { r.ranges = rs.map(x => ({ row: x.row, col: x.col, nr: x.nr, nc: x.nc })); return b; },
        build() {
          return Object.assign({}, r, {
            getBooleanCondition: () => (r.formula === null ? null : {
              getCriteriaType: () => 'CUSTOM_FORMULA', getCriteriaValues: () => [r.formula]
            }),
            getRanges: () => r.ranges
          });
        }
      };
      return b;
    };
    const SpreadsheetApp = {
      getActive: () => world.ss, getActiveSpreadsheet: () => world.ss, ProtectionType: { SHEET: 'SHEET', RANGE: 'RANGE' },
      BooleanCriteria: { CUSTOM_FORMULA: 'CUSTOM_FORMULA' }, newConditionalFormatRule
    };
    return {
      SpreadsheetApp, Calendar: this.calendar.service(), MailApp, PropertiesService, LockService, ScriptApp,
      console: consoleMock, Logger: { log: (...a) => { exec.logs.push(fmt(a)); } },
      __now: () => world.now
    };
  }

  /** 트리거 실행 한 번: 새 전역 범위에서 소스 전체를 읽고 fnName을 부른다 */
  run(fnName, ...args) {
    const exec = { fn: fnName, at: this.now, logs: [], errors: [], warnings: [], mails: [], error: null, result: undefined };
    const ctx = vm.createContext(this.services(exec));
    vm.runInContext('Date.now = function now() { return __now(); };', ctx);
    this.ctxDate = vm.runInContext('Date', ctx);
    bundle(this.order, this.srcDir).script.runInContext(ctx); // srcDir: 이 세계에 배포된 판(바꾸면 다음 실행부터)
    if (Object.keys(this.configOverrides).length) {
      vm.runInContext('(function (o) { for (var k in o) { var v = o[k]; if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(CONFIG[k], v); else CONFIG[k] = v; } })', ctx)(clone(this.configOverrides));
    }
    this.ctx = ctx;
    this.lockHeld = false;
    const fn = ctx[fnName];
    if (typeof fn !== 'function') throw new Error('함수 없음: ' + fnName);
    try {
      exec.result = fn.apply(null, args);
    } catch (e) {
      exec.error = e;
      exec.errorText = mapStack(e && e.stack ? e.stack : String(e));
    }
    this.lockHeld = false; // 실행이 끝나면 잠금은 풀린다
    exec.errors = exec.errors.map(mapStack);
    this.execs.push(exec);
    return exec;
  }
  /** 마지막 실행 컨텍스트에서 식 평가(검사용) */
  eval(code) { return vm.runInContext(code, this.ctx); }

  // 시트 읽기(검사용) ----------------------------------------------------
  sheet(name) { return this.ss.getSheetByName(name); }
  table(name) {
    const sh = this.sheet(name);
    if (!sh) return [];
    const width = sh.getLastColumn();
    const hdr = (sh.cells[0] || []).slice(0, width);
    const out = [];
    for (let r = 2; r <= sh.getLastRow(); r++) {
      const row = sh.cells[r - 1] || [];
      const o = { _row: r };
      hdr.forEach((h, i) => {
        const v = i < row.length ? row[i] : '';
        o[h] = v && typeof v === 'object' && v.t === 'd' ? v.ms : v;
      });
      o._raw = row;
      out.push(o);
    }
    return out;
  }
  /** 기록을 등록시각 순(같으면 먼저 생긴 행 먼저)으로 — 시트가 최신순으로 정렬돼 있어도 검사는 같은 순서로 본다 */
  rows() {
    return this.table('예약기록').filter(r => r['일정ID'] !== '')
      .map((r, i) => ({ r, i, t: typeof r['등록시각'] === 'number' ? r['등록시각'] : 0 }))
      .sort((a, b) => a.t - b.t || a.i - b.i)
      .map(x => x.r);
  }
  rowsOf(eventId) { return this.rows().filter(r => String(r['일정ID']) === String(eventId)); }
}

module.exports = { World, kst, isoKst, isoUtc, mapStack, bundle, SRC_ORDER };
