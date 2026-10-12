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

  /** 1행 제목으로 열 위치를 찾는다. 시트에 없는 열은 오른쪽 끝에 제목을 더한다 */
  function columns() {
    if (cols) return cols;
    const sh = sheet(SHEETS.RESERVATIONS);
    const hdr = headerOf(sh);
    const c = {};
    hdr.forEach((name, i) => { if (name && !(name in c)) c[name] = i; });
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

  return {
    sheet,

    all: load,

    /** 「예약기록」 열 제목 → 열 위치(0부터) */
    columns,

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

    /** 「주간보고」에 지난주 사람별 행을 덧붙인다. 시트를 지웠으면 건너뛴다(브리핑은 「예약기록」에서 계산하므로 영향 없음) */
    appendWeekly(values) {
      if (values.length) {
        const sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.WEEKLY);
        if (!sh) { console.log('「' + SHEETS.WEEKLY + '」 시트가 없어 주간 기록을 남기지 않았습니다.'); return; }
        ensureRows(sh, sh.getLastRow() + values.length, [1]);
        sh.getRange(sh.getLastRow() + 1, 1, values.length, values[0].length).setValues(values.map(r => r.map(safeText_)));
      }
    }
  };
})();
