/**
 * 설치 순서: setup → fillEquipmentSheet → (「장비」 확인) → checkCalendars → previewBookerNames
 *           → testMail → initialSync → installTriggers
 */
function setup() {
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone('Asia/Seoul');
  // 빈 기본 시트(시트1)는 지우지 않고 첫 시트로 이름만 바꿔 쓴다.
  // (스프레드시트 창에서 선택된 시트를 지우면 편집기에서 실행할 때 'Sheet 0 not found' 오류가 난다)
  let blank = ss.getSheets().find(sh => /^(Sheet1|시트1)$/.test(sh.getName()) && sh.getLastRow() === 0) || null;
  const make = (name, headers, widths, example) => {
    let sh = ss.getSheetByName(name);
    if (!sh) {
      if (blank) { sh = blank.setName(name); blank = null; } else sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#eef2f7');
      sh.setFrozenRows(1);
      widths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
      if (example) sh.getRange(2, 1, 1, example.length).setValues([example]).setFontColor('#999999');
    }
    return sh;
  };
  const col = (sh, i) => sh.getRange(1, i + 1, sh.getMaxRows(), 1);

  const eq = make(SHEETS.EQUIPMENT, ['장비명', '캘린더ID', '사용(Y/N)', '권한'], [260, 420, 80, 120]);
  [0, 1].forEach(i => col(eq, i).setNumberFormat('@'));
  // 사용자: 처음 보는 예약자 이름이 자동으로 추가된다. 같은 사람의 다른 표기는 대표 이름 행의 별칭 칸에 적고 그 표기의 행은 지운다
  const us = make(SHEETS.USERS, USER_HEADERS, [160, 360, 240], ['(예) UserA', 'usera, 나다, 가나다', 'usera@example.com']);
  [0, 1, 2].forEach(i => col(us, i).setNumberFormat('@'));
  ensureUserHeaders_();

  // 예약기록: 열 너비·서식(글자·날짜)·스크립트용 열 숨김·직전 취소 빨간색은 formatRecordSheet_
  const res = make(SHEETS.RESERVATIONS, RES_HEADERS, []);
  formatRecordSheet_(res, Store.columns());

  const wk = make(SHEETS.WEEKLY, ['주 시작', '예약자', '사용', '정상취소·변경', '직전취소', '이행률', '사용일', '취소일'],
    [140, 140, 60, 90, 70, 70, 320, 320]);
  col(wk, 0).setNumberFormat('yyyy-mm-dd(ddd) hh:mm');
  col(wk, 1).setNumberFormat('@');
  col(wk, 5).setNumberFormat('0%');

  protectSheets();
  arrangeSheetTabs();
  console.log('시트 준비 완료. fillEquipmentSheet()를 실행해 캘린더 목록을 채우세요.');
}

/** 시트 탭 순서(왼쪽부터). 스크립트는 시트를 이름으로 찾으므로 순서는 보기 편하게만 정한다 */
const sheetTabOrder_ = () => [SHEETS.RESERVATIONS, SHEETS.WEEKLY, SHEETS.EQUIPMENT, SHEETS.USERS];

/** 탭을 예약기록 · 주간보고 · 장비 · 사용자 순서로 놓는다(그 밖의 탭은 뒤에 그대로). 여러 번 실행해도 된다 */
function arrangeSheetTabs() {
  const ss = SpreadsheetApp.getActive();
  const order = sheetTabOrder_();
  let pos = 1;
  for (const name of order) {
    const sh = ss.getSheetByName(name);
    if (!sh) continue;
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(pos++);
  }
  const first = ss.getSheetByName(order[0]);
  if (first) ss.setActiveSheet(first);
  console.log('시트 탭 순서를 정리했습니다.');
  logPersonalDetails_('시트 탭 순서: ' + ss.getSheets().map(s => s.getName()).join(' · '));
}

/**
 * 시트 4개를 「관리자(이 스크립트를 실행하는 소유자)만 수정」으로 보호한다. 여러 번 실행해도 된다.
 * 공유 설정에서 다른 사람을 뷰어로 두는 것이 기본이고, 이것은 편집 권한이 잘못 주어졌을 때를 위한 안전장치다.
 * 스크립트는 소유자 권한으로 돌기 때문에 기록은 계속 쓴다.
 */
function protectSheets() {
  const ss = SpreadsheetApp.getActive();
  const done = [];
  for (const name of [SHEETS.EQUIPMENT, SHEETS.USERS, SHEETS.RESERVATIONS, SHEETS.WEEKLY]) {
    const sh = ss.getSheetByName(name);
    if (!sh) continue;
    protectSheet_(sh);
    done.push(name);
  }
  console.log('보호한 시트: ' + done.join(', ') + '\n다른 사람은 공유 설정에서 뷰어로 두세요(편집 권한이 있으면 Apps Script도 고칠 수 있음).');
}

function protectSheet_(sh) {
  const p = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET)[0] || sh.protect();
  p.setDescription('장비 예약 알림: 관리자만 수정');
  p.removeEditors(p.getEditors()); // 소유자는 빠지지 않는다
  if (p.canDomainEdit()) p.setDomainEdit(false);
}

/**
 * 「예약기록」 열 서식(글자·날짜), 너비, 제목 줄, 스크립트용 열 숨김. c: 열 제목 → 열 위치(0부터)
 */
function formatRecordSheet_(sh, c) {
  const col = h => sh.getRange(1, c[h] + 1, sh.getMaxRows(), 1);
  RES_TEXT_COLS.forEach(h => col(h).setNumberFormat('@'));
  RES_DATE_COLS.forEach(h => col(h).setNumberFormat(h === '등록시각' ? 'yyyy-mm-dd(ddd) hh:mm:ss' : 'yyyy-mm-dd(ddd) hh:mm'));
  RES_HEADERS.forEach(h => sh.setColumnWidth(c[h] + 1, RES_WIDTHS[h] || 120));
  sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), RES_HEADERS.length)).setFontWeight('bold').setBackground('#eef2f7');
  sh.setFrozenRows(1);
  RES_HIDDEN_COLS.forEach(h => sh.hideColumns(c[h] + 1));
  highlightLateRows_(sh, c);
}

const LATE_FILL = '#f8d7da';  // 직전 취소 행 배경(옅은 빨강)
const LATE_FONT = '#b3261e';  // 직전 취소 행 글자(빨강)
const colLetter_ = n => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };

/**
 * 직전취소 = Y인 행을 빨간색으로 표시한다(조건부 서식이라 정렬·새 기록에도 따라간다).
 * 이 스크립트가 만든 규칙(=$X2="Y")만 바꾸고 관리자가 만든 다른 규칙은 둔다. c: 열 제목 → 열 위치(0부터)
 */
function highlightLateRows_(sh, c) {
  const ours = rule => {
    try {
      const b = rule.getBooleanCondition();
      return !!b && b.getCriteriaType() === SpreadsheetApp.BooleanCriteria.CUSTOM_FORMULA &&
        /^=\$[A-Z]+2="Y"$/.test(String(b.getCriteriaValues()[0]));
    } catch (e) {
      return false;
    }
  };
  const width = Math.max(sh.getLastColumn(), RES_HEADERS.length);
  const rules = sh.getConditionalFormatRules().filter(r => !ours(r));
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$' + colLetter_(c['직전취소'] + 1) + '2="Y"')
    .setBackground(LATE_FILL)
    .setFontColor(LATE_FONT)
    .setRanges([sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), width)])
    .build());
  sh.setConditionalFormatRules(rules);
}

/**
 * 이 계정이 볼 수 있는 캘린더를 「장비」 시트에 채운다(이미 있는 캘린더는 건너뜀).
 * 이름이 [LAB-A]처럼 [호실]로 시작하는 캘린더는 사용=Y, 나머지는 N.
 * 같은 이름이 있으면 (2), (3)을 붙인다. 권한이 free/busy뿐이면 제목을 볼 수 없어 N.
 */
function fillEquipmentSheet() {
  const sh = Store.sheet(SHEETS.EQUIPMENT);
  const values = sh.getDataRange().getValues().slice(1);
  const existing = new Set(values.map(v => String(v[1]).trim()));
  const usedNames = new Set(values.map(v => String(v[0]).trim()));
  const add = [];
  const warn = [];
  let pageToken = null;
  do {
    const resp = Calendar.CalendarList.list({ maxResults: 250, pageToken: pageToken || undefined });
    for (const c of resp.items || []) {
      if (existing.has(c.id)) continue;
      let name = c.summaryOverride || c.summary || c.id;
      for (let n = 2; usedNames.has(name); n++) name = (c.summaryOverride || c.summary || c.id) + ' (' + n + ')';
      usedNames.add(name);
      const isEquipment = /^\s*\[[^\]]+\]/.test(name);
      const readable = c.accessRole === 'owner' || c.accessRole === 'writer' || c.accessRole === 'reader';
      add.push([name, c.id, isEquipment && readable ? 'Y' : 'N', c.accessRole || '']);
      if (isEquipment && c.accessRole === 'freeBusyReader') warn.push(name + ': 「바쁨 여부만」 권한이라 제목을 볼 수 없음 → 공유 권한을 올리세요');
      if (isEquipment && c.accessRole === 'reader') warn.push(name + ': 「모든 일정 세부정보 보기」 권한은 비공개 일정의 제목을 볼 수 없음(가능하면 「일정 변경」 권한)');
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 4).setValues(add.map(row => row.map(safeText_)));
  console.log(add.length + '개 캘린더를 추가했습니다. 「장비」 시트의 사용(Y/N)과 장비명을 확인하세요.');
  logPersonalDetails_('추가한 캘린더 상세:\n' +
    add.map(a => a[2] + '  ' + a[0] + '  [' + a[3] + ']').join('\n') + (warn.length ? '\n\n주의:\n' + warn.join('\n') : ''));
}

const USER_HEADERS = ['대표 이름', '별칭(쉼표로 구분, 선택)', '이메일(개인 알림, 선택)'];

/** 예전에 만든 「사용자」 시트에 이메일 칸 제목이 없으면 더한다 */
function ensureUserHeaders_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.USERS);
  if (!sh || sh.getRange(1, 3).getValue()) return;
  sh.getRange(1, 3).setValue(USER_HEADERS[2]).setFontWeight('bold').setBackground('#eef2f7');
  sh.setColumnWidth(3, 240);
  sh.getRange(1, 3, sh.getMaxRows(), 1).setNumberFormat('@');
}

/** 지금까지 기록된 예약자 이름을 「사용자」 시트에 채운다(이미 있는 이름은 건너뜀). 새 이름은 동기화 때 자동으로 더해진다 */
function fillUserSheet() {
  ensureUserHeaders_();
  const names = Store.all().slice().sort((a, b) => a.created - b.created).map(r => r.booker);
  const added = addUserNames_(names);
  console.log(added.length ? added.length + '명 추가했습니다.' : '추가할 새 이름이 없습니다.');
  if (added.length) logPersonalDetails_('추가한 예약자: ' + added.join(', '));
}

/**
 * 위반 표시가 붙은 예약(지난 7일 이후)과 그 이유를 로그에 보여 준다.
 * 겹침이면 겹치는 상대 일정의 제목·시간·만든 계정·비고까지 — 캘린더에서 어떤 일정인지 찾을 때 쓴다(발송 없음).
 */
function explainFlags() {
  const all = Store.active();
  const since = Date.now() - 7 * DAY_MS;
  const lines = [];
  for (const r of all.filter(x => x.end >= since).sort((a, b) => a.start - b.start)) {
    const v = checkViolations(r, all, CONFIG);
    if (!v.length) continue;
    lines.push('■ ' + r.booker + '  ' + fmtSlot(r.start, r.end) + '  ' + r.equipment + '  「' + r.title + '」');
    lines.push('   위반: ' + v.join(' / '));
    all.filter(o => o !== r && o.eventId !== r.eventId && overlaps(o, r)).forEach(o => lines.push(
      '   겹치는 일정: 「' + o.title + '」 예약자 ' + o.booker + ' · ' + fmtSlot(o.start, o.end) +
      ' · 만든 계정 ' + (o.creator || '-') + (o.note ? ' · 비고 ' + o.note : '') + ' · 시트 ' + o.rowNum + '행'));
  }
  console.log(lines.length ? '위반 상세는 개인정보 로그 설정을 켜면 확인할 수 있습니다.' : '위반 표시가 있는 예약이 없습니다.');
  if (lines.length) logPersonalDetails_(lines.join('\n'));
}

/** 「장비」 시트의 캘린더를 읽을 수 있는지, 권한은 무엇인지 확인 */
function checkCalendars() {
  for (const eq of Store.equipments()) {
    try {
      const c = Calendar.CalendarList.get(eq.calendarId);
      const role = c.accessRole;
      const note = role === 'freeBusyReader' ? ' ← 제목을 볼 수 없음(권한 부족)' :
        role === 'reader' ? ' (비공개 일정 제목은 안 보임)' : '';
      logPersonalDetails_('OK  ' + eq.name + ' → ' + (c.summaryOverride || c.summary) + ' [' + role + ']' + note);
    } catch (err) {
      console.error('캘린더 권한 확인에 실패했습니다.');
      logPersonalDetails_('실패 ' + eq.name + ' (' + eq.calendarId + '): ' + err);
    }
  }
}

function installTriggers() {
  const handlers = ['syncAll', 'onCalendarEventUpdated', 'weeklyReport'];
  ScriptApp.getProjectTriggers()
    .filter(t => handlers.indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));

  // 월 09:00 브리핑·주간 보고도 이 동기화가 보낸다(따로 트리거를 두지 않음: 시간 트리거는 1시간 안에서 아무 때나 실행됨)
  ScriptApp.newTrigger('syncAll').timeBased().everyMinutes(CONFIG.SYNC_EVERY_MINUTES).create();

  if (CONFIG.USE_CALENDAR_TRIGGERS) {
    for (const eq of Store.equipments()) {
      try {
        ScriptApp.newTrigger('onCalendarEventUpdated').forUserCalendar(eq.calendarId).onEventUpdated().create();
      } catch (err) {
        console.error('캘린더 트리거를 설치하지 못했습니다. 시간 트리거로 동기화합니다.');
        logPersonalDetails_('캘린더 트리거 설치 실패 ' + eq.name + ': ' + err + ' (시간 트리거로 계속 동기화됩니다)');
      }
    }
  }
  console.log('트리거 설치 완료: ' + ScriptApp.getProjectTriggers().length + '개');
}

/** 제목에서 읽은 예약자 이름 확인(발송 없음): 지난 7일 ~ 앞으로 14일 일정의 제목 → 예약자 */
function previewBookerNames() {
  const now = Date.now();
  const aliases = Store.aliases();
  for (const eq of Store.equipments()) {
    const lines = [];
    let pageToken = null;
    do {
      const o = {
        singleEvents: true, orderBy: 'startTime', maxResults: 2500,
        timeMin: new Date(now - 7 * DAY_MS).toISOString(), timeMax: new Date(now + 14 * DAY_MS).toISOString()
      };
      if (pageToken) o.pageToken = pageToken;
      const resp = Calendar.Events.list(eq.calendarId, o);
      (resp.items || []).filter(ev => ev.start && ev.start.dateTime).forEach(ev => {
        const name = parseBooker(ev.summary, aliases);
        lines.push('  ' + fmtSlot(Date.parse(ev.start.dateTime), Date.parse(ev.end.dateTime)) + '  「' +
          (ev.summary || '(제목 없음)') + '」 → ' + (name || '(이름 없음)'));
      });
      pageToken = resp.nextPageToken;
    } while (pageToken);
    console.log(lines.length + '개 일정의 예약자 해석을 확인했습니다.');
    logPersonalDetails_('[' + eq.name + ']\n' + lines.join('\n'));
  }
}

/** 메일 발송 확인(관리자에게만). 남은 할당량: 일반 Gmail 계정은 하루 100명 */
function testMail() {
  const ok = sendAdminMail_(CONFIG.SUBJECT_PREFIX + ' 테스트(관리자)', '장비 예약 알림 메일 발송 테스트입니다.');
  console.log((ok ? '관리자 테스트 메일을 보냈습니다.' : '관리자 테스트 메일에 실패했습니다.') + ' / 남은 일일 할당량: ' + safeQuota_());
  logPersonalDetails_('관리자 테스트 수신자: ' + CONFIG.ADMIN_EMAILS.join(','));
}

/**
 * 그룹 메일 맨 아래 안내(GROUP_FOOTER = 'notice') 시험. Config.gs의 TEST_GROUP_EMAIL(관리자만 회원인 시험용 그룹 주소)로
 * 이번 주 브리핑 견본을 한 통 보낸다. 실제 그룹에는 보내지 않는다. 그룹을 거쳐 받은 메일의 맨 아래를 확인한다.
 */
function testFooterMail() {
  const to = String(CONFIG.TEST_GROUP_EMAIL || '').trim();
  if (!isSingleEmail_(to) || to.toLowerCase() === String(CONFIG.GROUP_EMAIL || '').trim().toLowerCase()) {
    console.warn('Config.gs의 TEST_GROUP_EMAIL에 실제 그룹이 아닌 시험용 그룹 주소를 적은 뒤 다시 실행하세요.');
    return;
  }
  const now = Date.now();
  const b = buildBriefing_(weekStartFor(now), now, null);
  const ok = sendMail_({ to, subject: '[시험] ' + b.subject, body: b.body, html: b.html + groupFooterHtml_(to) });
  console.log(ok ? '시험용 그룹으로 견본을 보냈습니다. 그룹을 거쳐 받은 메일의 맨 아래를 확인하세요.' :
    '시험 메일을 보내지 못했습니다(주소 형식 확인).');
}

/** 그룹으로 실제 한 통(그룹 게시 권한·회원 수신 확인용) */
function testGroupMail() {
  const ok = sendGroupMail_(CONFIG.SUBJECT_PREFIX + ' 테스트 · 알림 받기 확인', '장비 예약 알림이 그룹으로 오는지 확인하는 메일입니다.\n' +
    '이 메일이 휴대폰 알림으로 오지 않았다면 그룹 구독과 Gmail 필터를 확인해 주세요.');
  console.log((ok ? '그룹 테스트 메일을 보냈습니다.' : '그룹 테스트 메일에 실패했습니다.') +
    ' groups.google.com의 대화 목록·대기(Pending)도 확인하세요. 남은 할당량: ' + safeQuota_());
  logPersonalDetails_('그룹 테스트 수신자: ' + (CONFIG.GROUP_EMAIL || CONFIG.ADMIN_EMAILS.join(',')));
}
