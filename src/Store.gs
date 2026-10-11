/**
 * 스프레드시트 저장소. 한 번 실행하는 동안 시트를 한 번만 읽고, 바뀐 행은 commit()에서 한꺼번에 쓴다.
 * 행 번호(rowNum)는 그 실행 안에서만 쓴다. 행 순서는 정렬로 바뀔 수 있으므로, 실행을 넘어 기억할 때는
 * recordKey(캘린더·일정ID·시작)를 쓴다(행은 지우지 않는다).
 */
/**
 * 「예약기록」 열. 사람이 보는 순서로 두고, 스크립트용 열(캘린더ID부터)은 오른쪽 끝에 숨긴다.
 * 읽고 쓸 때는 1행의 열 제목으로 위치를 찾으므로, 관리자가 열 순서를 바꿔도 기록은 제자리에 들어간다.
 */
const RES_HEADERS = [
  '등록시각',      // 캘린더에 처음 등록한 시각(이 열 내림차순 = 최신이 위)
  '예약자', '장비', '시작', '종료',
  '등록구분',      // 정기예약 / 추가예약 / 기간전예약 / 수업예약 / 점검
  '상태',          // 예약 / 취소 / 변경 / 양도
  '취소시각',
  '직전취소',      // 취소·변경일 때 Y / N
  '직전취소기준',  // 이 시각부터 취소하면 직전 취소
  '제외사유',      // 직전 취소로 치지 않은 이유: 유예 / 양보 / 수업 / 점검
  '위반', '제목', '비고', '만든계정',
  '캘린더ID', '일정ID',
  '마감시작', '마감종료' // 월 09:00 뒤 시간을 바꾼 정기예약: 기간이 끝날 때의 시간(하루 제한 판정)
];
const RES_HIDDEN_COLS = ['캘린더ID', '일정ID', '마감시작', '마감종료'];
/** 예전 열 제목 → 지금 제목(null = 없앤 열) */
const RES_OLD_HEADERS = { '늦은취소': '직전취소', '늦은취소기준': '직전취소기준', '판정사유': '제외사유', '순위시각': null };
const COL = {};
RES_HEADERS.forEach((h, i) => { COL[h] = i; });
// 글자로 저장할 열(시트가 숫자·날짜로 바꾸지 않도록 표시 형식 '@')
const RES_TEXT_COLS = ['예약자', '장비', '등록구분', '상태', '직전취소', '제외사유', '위반', '제목', '비고', '만든계정', '캘린더ID', '일정ID'];
const RES_DATE_COLS = ['등록시각', '시작', '종료', '취소시각', '직전취소기준', '마감시작', '마감종료'];
const RES_WIDTHS = {
  등록시각: 170, 예약자: 110, 장비: 230, 시작: 140, 종료: 140, 등록구분: 85, 상태: 55, 취소시각: 140,
  직전취소: 65, 직전취소기준: 140, 제외사유: 70, 위반: 260, 제목: 200, 비고: 220, 만든계정: 180,
  캘린더ID: 200, 일정ID: 160, 마감시작: 140, 마감종료: 140
};
/** 예전 제목을 지금 제목으로(모르는 제목은 그대로, 없앤 열은 null). 앞뒤 괄호·공백은 무시 */
const resHeaderName_ = h => {
  const s = String(h).trim().replace(/^[(（\[]\s*(.*?)\s*[)）\]]$/, '$1');
  return Object.prototype.hasOwnProperty.call(RES_OLD_HEADERS, s) ? RES_OLD_HEADERS[s] : s;
};
/** 지금까지 쓴 열 순서(예전 판, 지금 판) */
const RES_LAYOUTS = [
  ['장비', '캘린더ID', '일정ID', '예약자', '제목', '시작', '종료', '등록시각', '등록구분', '상태', '취소시각', '직전취소',
    '늦은취소기준', '위반', '만든계정', '비고', '순위시각', '마감시작', '마감종료', '판정사유'],
  RES_HEADERS
];
/**
 * 1행 제목 → 열마다 지금 이름(없앤 열·모르는 열·빈 칸은 null). 제목 칸이 비어 있어도(실수로 지움) 나머지 제목이
 * 모두 어느 판의 열 순서와 같은 자리에 있으면 빈 칸을 그 판의 이름으로 본다.
 */
function resColumnNames_(hdr) {
  const blank = hdr.map(h => String(h).trim() === '');
  const names = hdr.map((h, i) => (blank[i] ? null : resHeaderName_(h) || null));
  if (!blank.some(Boolean)) return names;
  for (const layout of RES_LAYOUTS) {
    let same = 0;
    let diff = 0;
    hdr.forEach((h, i) => {
      if (blank[i] || i >= layout.length) return;
      if (resHeaderName_(h) === resHeaderName_(layout[i])) same++; else diff++;
    });
    if (!diff && same >= 5) return names.map((n, i) => (blank[i] && i < layout.length ? resHeaderName_(layout[i]) : n));
  }
  return names;
}

/** 기록을 실행을 넘어 가리키는 열쇠(행 순서가 바뀌어도 그대로) */
const recordKey = r => r.calendarId + '|' + r.eventId + '|' + r.start;

/** setup()이 넣은 회색 예시 행 */
const isExample_ = v => String(v).trim().indexOf('(예)') === 0;

/** 수식으로 읽히지 않도록 */
const safeText_ = v => (typeof v === 'string' && /^[\s\uFEFF]*[=+@-]/.test(v) ? "'" + v : v);

const Store = (() => {
  let rows = null;
  let byRowNum = null;
  let nextRow = 0;
  let pending = [];      // 아직 시트에 쓰지 않은 새 행
  let dirty = new Set(); // 고친 기존 행
  let aliasCache = null;
  let newNames = [];     // 이번 실행에 새로 기록한 예약자 이름(「사용자」 시트 자동 추가용)
  let cols = null;       // 「예약기록」 열 제목 → 열 위치(0부터)
  let width = 0;         // 「예약기록」에서 쓰는 열 수

  function sheet(name) {
    const sh = SpreadsheetApp.getActive().getSheetByName(name);
    if (!sh) throw new Error('「' + name + '」 시트가 없습니다. setup()을 먼저 실행하세요.');
    return sh;
  }

  /** 시트 칸이 모자라면 늘린다(getRange는 칸을 늘려 주지 않는다). 새 행에도 글자 서식을 준다. 반환: 늘렸는지 */
  function ensureRows(sh, lastRow, textCols) {
    const max = sh.getMaxRows();
    if (lastRow <= max) return false;
    const add = lastRow - max + 500;
    sh.insertRowsAfter(max, add);
    (textCols || []).forEach(c => sh.getRange(max + 1, c + 1, add, 1).setNumberFormat('@'));
    return true;
  }

  const toMs = v => (v instanceof Date ? v.getTime() : v === '' || v === null || v === undefined ? null :
    typeof v === 'number' ? v : Date.parse(v) || null);

  function headerOf(sh) {
    const n = sh.getLastColumn();
    return n ? sh.getRange(1, 1, 1, n).getValues()[0].map(h => String(h).trim()) : [];
  }

  /** 1행 제목으로 열 위치를 찾는다(예전 제목도). 시트에 없는 열은 오른쪽 끝에 제목을 더한다 */
  function columns() {
    if (cols) return cols;
    const sh = sheet(SHEETS.RESERVATIONS);
    const hdr = headerOf(sh);
    const c = {};
    resColumnNames_(hdr).forEach((name, i) => {
      if (!name || name in c) return;
      c[name] = i;
      if (!hdr[i]) sh.getRange(1, i + 1).setValue(name); // 비어 있던 제목 칸을 채운다
    });
    const missing = RES_HEADERS.filter(h => !(h in c));
    if (missing.length) {
      sh.getRange(1, hdr.length + 1, 1, missing.length).setValues([missing]);
      missing.forEach((h, i) => {
        c[h] = hdr.length + i;
        if (RES_TEXT_COLS.indexOf(h) >= 0) sh.getRange(1, c[h] + 1, sh.getMaxRows(), 1).setNumberFormat('@');
      });
    }
    cols = c;
    width = hdr.length + missing.length;
    return cols;
  }

  function load() {
    if (rows) return rows;
    const sh = sheet(SHEETS.RESERVATIONS);
    const c = columns();
    const values = sh.getDataRange().getValues().slice(1);
    nextRow = Math.max(sh.getLastRow(), 1) + 1;
    rows = values.map((v, i) => {
      const at = h => (v[c[h]] === undefined || v[c[h]] === null ? '' : v[c[h]]);
      return {
        rowNum: i + 2,
        raw: v,
        equipment: String(at('장비')),
        calendarId: String(at('캘린더ID')),
        eventId: String(at('일정ID')),
        booker: String(at('예약자')),
        bookerKey: bookerKeyOf(at('예약자')),
        title: String(at('제목')),
        start: toMs(at('시작')),
        end: toMs(at('종료')),
        created: toMs(at('등록시각')),
        kind: String(at('등록구분')),
        status: String(at('상태')),
        cancelled: toMs(at('취소시각')),
        late: at('직전취소') === 'Y',
        lateFrom: toMs(at('직전취소기준')),
        violations: String(at('위반')),
        creator: String(at('만든계정')),
        note: String(at('비고')),
        windowStart: toMs(at('마감시작')),
        windowEnd: toMs(at('마감종료')),
        lateReason: String(at('제외사유'))
      };
    }).filter(r => r.eventId && r.calendarId && r.start !== null);
    byRowNum = new Map(rows.map(r => [r.rowNum, r]));
    return rows;
  }

  /** 시트의 열 순서대로 한 행. 스크립트가 모르는 열(관리자가 더한 열)은 원래 값을 그대로 둔다 */
  function toValues(r) {
    const c = columns();
    const d = ms => (ms ? new Date(ms) : '');
    const v = [];
    for (let i = 0; i < width; i++) v.push(r.raw && i < r.raw.length ? safeText_(r.raw[i]) : '');
    const put = (h, x) => { v[c[h]] = x; };
    put('등록시각', d(r.created));
    put('예약자', safeText_(r.booker));
    put('장비', safeText_(r.equipment));
    put('시작', d(r.start));
    put('종료', d(r.end));
    put('등록구분', r.kind);
    put('상태', r.status);
    put('취소시각', d(r.cancelled));
    put('직전취소', r.status === STATUS.CANCELLED || r.status === STATUS.MOVED ? (r.late ? 'Y' : 'N') : '');
    put('직전취소기준', d(r.lateFrom));
    put('제외사유', r.lateReason || '');
    put('위반', safeText_(r.violations || ''));
    put('제목', safeText_(r.title));
    put('비고', safeText_(r.note || ''));
    put('만든계정', r.creator || '');
    put('캘린더ID', r.calendarId);
    put('일정ID', r.eventId);
    put('마감시작', d(r.windowStart));
    put('마감종료', d(r.windowEnd));
    return v.map(safeText_);
  }

  /**
   * 「예약기록」을 RES_HEADERS 순서로 옮겨 적는다(예전 열 순서·제목인 시트를 한 번). 원래 시트는 먼저
   * 「예약기록_백업」으로 복사해 둔다. 없앤 열(순위시각)은 백업에만 남고, 스크립트가 모르는 열은 오른쪽 끝에 둔다.
   * 반환: 옮겨 적었는지(이미 그 순서면 false)
   */
  function arrangeColumns() {
    const ss = SpreadsheetApp.getActive();
    const sh = sheet(SHEETS.RESERVATIONS);
    if (pending.length || dirty.size) throw new Error('arrangeColumns: 쓰지 않은 기록이 있습니다');
    const hdr = headerOf(sh);
    if (RES_HEADERS.every((h, i) => hdr[i] === h)) return false;
    const last = Math.max(sh.getLastRow(), 1);
    const old = hdr.length ? sh.getRange(1, 1, last, hdr.length).getValues() : [[]];
    if (last > 1) {
      let name = SHEETS.RESERVATIONS + '_백업';
      for (let k = 2; ss.getSheetByName(name); k++) name = SHEETS.RESERVATIONS + '_백업' + k;
      const backup = sh.copyTo(ss).setName(name);
      protectSheet_(backup);
    }
    const names = resColumnNames_(hdr);
    const src = {};
    names.forEach((name, i) => { if (name && !(name in src)) src[name] = i; });
    const extra = [];
    names.forEach((name, i) => { if (name && RES_HEADERS.indexOf(name) < 0) extra.push(i); });
    const header = RES_HEADERS.concat(extra.map(i => hdr[i]));
    const values = [header].concat(old.slice(1).map(v =>
      RES_HEADERS.map(h => (h in src ? v[src[h]] : '')).concat(extra.map(i => v[i])).map(x => safeText_(x === null || x === undefined ? '' : x))));
    // 지우기 전에 덮어쓴다(중간에 멈춰도 원래 제목이 남아 다음 실행에서 다시 옮긴다). 남는 오른쪽 열만 비운다
    sh.showColumns(1, Math.max(hdr.length, header.length));
    formatRecordSheet_(sh, COL);
    sh.getRange(1, 1, values.length, header.length).setValues(values);
    if (hdr.length > header.length) sh.getRange(1, header.length + 1, last, hdr.length - header.length).clearContent();
    rows = null;
    byRowNum = null;
    cols = null;
    return true;
  }

  /**
   * 「예약기록_백업」(열을 옮기기 전 시트)의 행과 지금 기록을 짝짓는다. 백업 뒤 그대로인 행(시작·예약자·상태·
   * 취소시각이 같음)을 먼저, 다음은 백업 당시 「예약」이던 같은 일정의 행, 일정ID가 바뀐 같은 예약(같은 시간·예약자),
   * 마지막으로 남은 후보 중 가장 이른 등록시각. 백업 행 순서와 상관없이 같은 결과.
   * keep(r): 짝지을 기록만(없으면 전부). 반환: null(백업 없음) 또는 { matches: [{ row, was, same, rivals }], maxCreated }
   *   was: 백업 행(등록시각·상태·구분·직전취소·제외사유·마감), same: 백업 뒤 그대로인 행,
   *   rivals: 같은 일정·시작·예약자인데 등록시각·상태·구분이 다른 백업 행이 있음(3판이 잘못 짝지었을 수 있음)
   */
  function matchBackup(keep) {
    const ss = SpreadsheetApp.getActive();
    let maxCreated = 0;
    let found = 0;
    const byEvent = new Map(); // 캘린더|일정ID → 백업 행들
    const bySlot = new Map();  // 캘린더|시작|종료|예약자 → 백업 당시 「예약」 행들(그 뒤 지우고 다시 만들어 일정ID가 바뀐 같은 예약)
    const push = (m, k, x) => { if (!m.has(k)) m.set(k, []); m.get(k).push(x); };
    for (const b of ss.getSheets()) {
      if (b.getName().indexOf(SHEETS.RESERVATIONS + '_백업') !== 0) continue;
      const values = b.getDataRange().getValues();
      if (values.length < 2) continue;
      const at = {};
      resColumnNames_(values[0].map(h => String(h).trim())).forEach((n, i) => { if (n && !(n in at)) at[n] = i; });
      if (!['등록시각', '캘린더ID', '일정ID', '시작'].every(h => h in at)) continue;
      const get = (v, h) => (h in at ? v[at[h]] : '');
      for (const v of values.slice(1)) {
        const created = toMs(get(v, '등록시각'));
        const start = toMs(get(v, '시작'));
        if (!created || start === null) continue;
        const cal = String(get(v, '캘린더ID'));
        const x = { created, start, end: toMs(get(v, '종료')), cancelled: toMs(get(v, '취소시각')),
          bookerKey: bookerKeyOf(get(v, '예약자')), status: String(get(v, '상태')), kind: String(get(v, '등록구분')),
          late: get(v, '직전취소') === 'Y', lateReason: String(get(v, '제외사유') || ''),
          windowStart: toMs(get(v, '마감시작')), windowEnd: toMs(get(v, '마감종료')) };
        maxCreated = Math.max(maxCreated, created);
        found++;
        push(byEvent, cal + '|' + String(get(v, '일정ID')), x);
        if (x.status === STATUS.ACTIVE) push(bySlot, cal + '|' + x.start + '|' + x.end + '|' + x.bookerKey, x);
      }
    }
    const sec_ = ms => (ms === null ? null : Math.floor(ms / 1000)); // 글자로 적힌 시각은 초까지만
    // 후보의 등록시각이 하나로 정해질 때만(같은 행이 백업 두 곳에 있어도 같은 값)
    const one = list => (list.length && list.every(x => x.created === list[0].created) ? list[0] : null);
    const earliest_ = list => list.reduce((a, b) => (a === null || b.created < a.created ? b : a), null);
    if (!found) return null;
    const out = [];
    for (const r of load()) {
      if (keep && !keep(r)) continue;
      const evs = byEvent.get(r.calendarId + '|' + r.eventId) || [];
      const sameStart = evs.filter(x => x.start === r.start && x.bookerKey === r.bookerKey);
      const same = one(sameStart.filter(x => x.status === r.status && sec_(x.cancelled) === sec_(r.cancelled)));
      const was =
        // 1) 백업 뒤 그대로인 행: 시작·예약자·상태·취소시각이 같은 백업 행
        same ||
        // 2) 같은 시작·예약자(백업 뒤 닫힘·양도, 메모 바로잡기): 백업 당시 「예약」이던 행 먼저
        one(sameStart.filter(x => x.status === STATUS.ACTIVE)) ||
        // 3) 백업 뒤 시간 조정·양도: 백업 당시 그 일정의 「예약」 행(한 일정에 하나). [fix] 수업·점검을 거쳐 되돌린 양도는
        //    그때 쥐고 있던 사람의 등록시각을 이어받으므로, 같은 예약자의 닫힌 백업 행보다 먼저 본다
        one(evs.filter(x => x.status === STATUS.ACTIVE)) || one(sameStart) ||
        // 4) 일정ID가 바뀐 같은 예약(같은 동기화에서 지우고 다시 만듦·반복 일정 나누기)
        (evs.length ? null : one(bySlot.get(r.calendarId + '|' + r.start + '|' + r.end + '|' + r.bookerKey) || [])) ||
        // 5) 그 일정의 등록시각이 하나뿐
        one(evs) ||
        // 6) 그래도 하나로 못 정하면(예전 판이 남긴 같은 일정의 「예약」 행 둘 등) 가장 가까운 후보 중 가장 이른 등록시각.
        //    빈 칸으로 두면 중복 순위 1순위·「등록 01/01」로 나오므로, 백업 순서와 상관없이 같은 값을 고른다
        earliest_([sameStart.filter(x => x.status === r.status), sameStart.filter(x => x.status === STATUS.ACTIVE), sameStart,
          evs.filter(x => x.status === STATUS.ACTIVE), evs].find(l => l.length) || []);
      if (!was) continue;
      const rivals = sameStart.some(x => x.created !== was.created || x.status !== was.status || x.kind !== was.kind);
      out.push({ row: r, was, same: !!same, rivals });
    }
    return { matches: out, maxCreated };
  }

  /** 비어 있는 등록시각을 백업에서 되살린다. 반환: [{ row, was }] */
  function restoreFromBackup() {
    const m = matchBackup(r => !r.created);
    if (!m) return [];
    for (const { row: r, was } of m.matches) {
      r.created = was.created;
      if (pending.indexOf(r) < 0) dirty.add(r);
    }
    return m.matches;
  }

  return {
    sheet,

    all: load,

    restoreFromBackup,

    matchBackup,

    /** 「예약기록」 열 제목 → 열 위치(0부터) */
    columns,

    arrangeColumns,

    byRow(rowNum) {
      load();
      return byRowNum.get(Number(rowNum)) || null;
    },

    /**
     * recordKey로 찾기. 같은 시간 그대로 양도하면 양도 행과 새 행이 같은 열쇠를 가지므로,
     * pick에 맞는 행 중 가장 늦게 닫은 것을 고른다(없으면 첫 행)
     */
    byKey(key, pick) {
      const c = load().filter(r => recordKey(r) === key);
      const p = pick ? c.filter(pick) : [];
      return p.reduce((a, b) => ((b.cancelled || 0) > (a.cancelled || 0) ? b : a), p[0] || null) || c[0] || null;
    },

    /** 이 캘린더의 기록이 있는지(시트를 읽는다) */
    hasCalendar(calendarId) {
      return load().some(r => r.calendarId === calendarId);
    },

    /** 이 일정의 현재 「예약」 상태 기록 */
    findActive(calendarId, eventId) {
      return load().find(r => r.calendarId === calendarId && r.eventId === eventId && r.status === STATUS.ACTIVE) || null;
    },

    /** 같은 일정 ID의 기록(캘린더 상관없이) */
    findByEvent(eventId) {
      return load().filter(r => r.eventId === eventId);
    },

    hasAny(calendarId, eventId) {
      return load().some(r => r.calendarId === calendarId && r.eventId === eventId);
    },

    active() {
      return load().filter(r => r.status === STATUS.ACTIVE);
    },

    append(r) {
      load();
      r.rowNum = nextRow++;
      pending.push(r);
      newNames.push(r.booker);
      rows.push(r);
      byRowNum.set(r.rowNum, r);
      return r;
    },

    save(r) {
      if (pending.indexOf(r) < 0) dirty.add(r);
    },

    /** 바뀐 내용을 시트에 쓴다. 새 행은 한 번에 */
    commit() {
      if (!rows) return;
      const sh = sheet(SHEETS.RESERVATIONS);
      const c = columns();
      const wrote = pending.length > 0 || dirty.size > 0;
      if (pending.length) {
        // 늘린 행에도 직전 취소 빨간색 표시가 닿도록 규칙 범위를 다시 잡는다
        if (ensureRows(sh, pending[0].rowNum + pending.length - 1, RES_TEXT_COLS.map(h => c[h]))) highlightLateRows_(sh, c);
        sh.getRange(pending[0].rowNum, 1, pending.length, width).setValues(pending.map(toValues));
      }
      for (const r of dirty) sh.getRange(r.rowNum, 1, 1, width).setValues([toValues(r)]);
      pending = [];
      dirty = new Set();
      if (wrote && CONFIG.SORT_RECORDS_NEWEST_FIRST) {
        // 등록시각 내림차순(최신이 위). 행 번호가 바뀌므로 다음에 쓸 때 시트를 다시 읽는다
        const last = sh.getLastRow();
        const w = Math.max(width, sh.getLastColumn());
        if (last > 2) sh.getRange(2, 1, last - 1, w).sort({ column: c['등록시각'] + 1, ascending: false });
        rows = null;
        byRowNum = null;
      }
    },

    /** 「장비」 시트: 장비명 | 캘린더ID | 사용(Y/N). 장비명이 비면 캘린더ID를 쓴다. */
    equipments() {
      return sheet(SHEETS.EQUIPMENT).getDataRange().getValues().slice(1)
        .filter(v => v[1] && !isExample_(v[0]) && String(v[2] || 'Y').trim().toUpperCase() !== 'N')
        .map(v => ({ name: String(v[0] || v[1]).trim(), calendarId: String(v[1]).trim() }));
    },

    /** 「사용자」 시트: 대표 이름 | 별칭(쉼표로 구분) | 이메일 — 이름은 자동으로 쌓이고, 별칭·이메일은 관리자가 적는다 */
    aliases() {
      if (aliasCache) return aliasCache;
      const sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.USERS);
      aliasCache = !sh ? [] : sh.getDataRange().getValues().slice(1)
        .filter(v => v[0] && !isExample_(v[0]))
        .map(v => ({
          name: String(v[0]).trim(),
          aliases: String(v[1] || '').split(/[,，、\n]/).map(s => s.trim()).filter(Boolean),
          email: String(v[2] || '').trim()
        }));
      return aliasCache;
    },

    /** 이번 실행에 기록한 예약자 이름을 꺼낸다 */
    takeNewNames() {
      const n = newNames;
      newNames = [];
      return n;
    },

    /**
     * 「사용자」 시트에 없는 이름을 맨 아래에 더한다(별칭 칸은 비움). 반환: 더한 이름들
     * 이름·별칭과 대소문자·공백만 다른 이름은 이미 있는 것으로 본다.
     */
    addUsers(names) {
      const sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.USERS);
      if (!sh || !names.length) return [];
      const known = new Set();
      this.aliases().forEach(u => [u.name].concat(u.aliases).forEach(a => known.add(bookerKeyOf(a))));
      const add = [];
      for (const n of names) {
        const k = bookerKeyOf(n);
        if (!k || known.has(k)) continue;
        known.add(k);
        add.push([n, '']);
      }
      if (add.length) {
        const first = sh.getLastRow() + 1;
        ensureRows(sh, first + add.length - 1, [0, 1]);
        sh.getRange(first, 1, add.length, 2).setValues(add.map(r => r.map(safeText_)));
        aliasCache = null;
      }
      return add.map(a => a[0]);
    },

    /** 「사용자」 시트에서 이 이름들의 행을 지운다(별칭·이메일이 빈 행만). 반환: 지운 이름들 */
    removeUsers(names) {
      const sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.USERS);
      if (!sh || !names.length) return [];
      const keys = new Set(names.map(bookerKeyOf));
      const values = sh.getDataRange().getValues();
      const removed = [];
      for (let i = values.length - 1; i >= 1; i--) {
        const v = values[i];
        if (!keys.has(bookerKeyOf(v[0])) || String(v[1] || '').trim() || String(v[2] || '').trim()) continue;
        sh.deleteRow(i + 1);
        removed.unshift(String(v[0]).trim());
      }
      if (removed.length) aliasCache = null;
      return removed;
    },

    appendWeekly(values) {
      if (values.length) {
        const sh = sheet(SHEETS.WEEKLY);
        ensureRows(sh, sh.getLastRow() + values.length, [1]);
        sh.getRange(sh.getLastRow() + 1, 1, values.length, values[0].length).setValues(values.map(r => r.map(safeText_)));
      }
    }
  };
})();
