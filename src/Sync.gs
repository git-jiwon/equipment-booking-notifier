/**
 * 캘린더 변경 감지. Calendar API의 syncToken으로 지난 동기화 이후 바뀐 일정만 받는다.
 * - 예약자는 일정 제목에 적힌 이름이다(연구원이 자기 이름으로 예약하고, 남의 예약은 지우지 않는다).
 * - 지워진 일정은 status = 'cancelled'로 오고 id만 확실히 들어 있으므로, 예약자·시간은 「예약기록」 값을 쓴다.
 * - 한 번 실행에서 모든 캘린더의 변경을 먼저 읽고, 지운 일정 → 나머지(등록 순) 순서로 처리한다.
 * - 사용 시작 뒤에 지우거나 다른 시간으로 옮겨도 직전 취소다. 원래 시간과 겹치게 줄이거나 늘린 것은 같은 예약.
 */
const TIME_BUDGET_MS = 4.5 * 60 * 1000; // 실행 한도 6분 전에 멈추고 남은 캘린더는 다음 실행에서
// 이번 실행에 새로 들어온 [Fix] 점검 일정. 지운 일정을 먼저 처리하므로, 같은 주기에 생긴 점검에 양보한 취소를 알아보려고 미리 모은다
let runFixes_ = [];

/** 시간 트리거(와 선택한 경우 캘린더 트리거)가 부르는 진입점 */
function syncAll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return;
  try {
    runSync_({ notify: true });
  } finally {
    lock.releaseLock();
  }
}

function onCalendarEventUpdated(e) {
  syncAll();
}

/** 처음 쓸 때·「장비」에 캘린더를 새로 추가했을 때: 아직 동기화한 적 없는 캘린더만 알림 없이 기록 */
function initialSync() {
  withLock_(() => {
    runSync_({ notify: false, onlyNew: true });
    const props = PropertiesService.getScriptProperties();
    const ws = weekStartFor(Date.now());
    // 설치한 주는 일부만 보았으므로 브리핑·이행률 보고를 건너뛴다(다음 월요일 브리핑, 그다음 월요일 첫 보고)
    if (!props.getProperty('briefingWeek')) props.setProperty('briefingWeek', String(ws));
    if (!props.getProperty('reportWeek')) props.setProperty('reportWeek', String(ws));
  });
}

/** 모든 캘린더를 처음부터 다시 읽기(알림 없음). 기록은 지우지 않고 맞춘다. */
function resetSync() {
  withLock_(() => runSync_({ notify: false, full: true }));
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(60 * 1000);
  try { return fn(); } finally { lock.releaseLock(); }
}

const tokenKey_ = id => 'syncToken:' + id;
const lastSyncKey_ = id => 'lastSync:' + id;

function runSync_(opt) {
  const t0 = Date.now();
  const props = PropertiesService.getScriptProperties();
  const errors = [];
  const fetched = [];
  let incomplete = false;
  try {
    migrateColumns_();
  } catch (err) {
    // 열 정리가 안 돼도 기록은 열 제목으로 찾아 쓰므로 동기화는 계속한다
    errors.push({ eq: { name: '「예약기록」 열 정리', calendarId: '_columns' }, err });
  }
  for (const eq of Store.equipments()) {
    if (Date.now() - t0 > TIME_BUDGET_MS) {
      console.warn('시간이 부족해 남은 캘린더는 다음 실행에서 동기화합니다.');
      logPersonalDetails_('다음 실행 시작 장비: ' + eq.name);
      incomplete = true;
      break;
    }
    if (opt.onlyNew && props.getProperty(tokenKey_(eq.calendarId))) continue;
    try {
      fetched.push(fetchCalendar_(eq, opt));
    } catch (err) {
      errors.push({ eq, err });
    }
  }
  try {
    migrateKinds_();
    processFetched_(fetched, errors);
    Store.commit();
    addNewUsers_();
    for (const f of fetched) {
      // 실패한 일정은 다음 증분 동기화에서 다시 읽도록 이전 토큰·동기화 시각을 유지한다.
      if (errors.some(e => e.eq.calendarId === f.eq.calendarId)) continue;
      if (f.nextSyncToken) props.setProperty(tokenKey_(f.eq.calendarId), f.nextSyncToken);
      props.setProperty(lastSyncKey_(f.eq.calendarId), String(f.fetchedAt));
    }
    fillHorizonDaily_(opt, t0, errors);
    if (opt.notify) {
      Outbox.flush();
      // 빠진 캘린더가 있으면 월요일 메일을 잠시 미룬다. 기준 시각은 이 실행이 캘린더를 읽기 시작한 때
      maybeSendMondayMails_(incomplete || errors.length > 0, t0);
    }
  } catch (err) {
    errors.push({ eq: { name: '전체', calendarId: '_run' }, err });
  }
  reportErrors_(errors);
}

/**
 * 예전 코드가 남긴 기록을 지금 규칙으로 바로잡는다(판마다 한 번).
 * - 7: 「우선예약」은 「정기예약」으로 이름이 바뀌었고, 반복 일정을 따로 「정기예약」으로 적던 규칙은 없앴다. [Fix]는 점검
 * - 8: 사용 시작 뒤 제목 변경(메모)을 양도로 적은 기록을 원래 예약자로, 「사용자」 시트의 사람 아닌 이름(점검·메모 제목)을 지움
 * - 9: 같은 일정에 「예약」 행이 둘 이상 남은 기록을 하나만 남기고 「중복」으로
 */
function migrateKinds_() {
  const props = PropertiesService.getScriptProperties();
  const version = Number(props.getProperty('kindsVersion') || 0);
  if (version >= 9) return;
  if (version === 8) {
    closeDuplicates_();
    props.setProperty('kindsVersion', '9');
    return;
  }
  let n = 0;
  if (version < 7) for (const r of Store.all()) {
    if (isMaintenanceTitle_(r.title) && r.kind !== KIND.MAINTENANCE) {
      r.kind = KIND.MAINTENANCE;
      r.booker = MAINTENANCE_NAME;
      r.bookerKey = bookerKeyOf(MAINTENANCE_NAME);
      r.lateFrom = lateCancelFrom(r.kind, r.start, CONFIG);
      if (r.status !== STATUS.ACTIVE) { r.late = false; r.lateReason = '점검'; }
      Store.save(r);
      n++;
      continue;
    }
    if (r.kind !== '정기예약' && r.kind !== '우선예약') continue;
    const kind = classifyBooking(r.created, r.start, false, isClassTitle_(r.title));
    if (kind === r.kind) continue;
    r.kind = kind;
    r.lateFrom = lateCancelFrom(r.kind, r.start, CONFIG);
    if (r.status === STATUS.ACTIVE) r.violations = checkViolations(r, Store.active(), CONFIG).join(' / ');
    Store.save(r);
    n++;
  }
  const memo = repairMemoTransfers_();
  refreshFlags_(null);
  Store.commit();
  renameLateHeaders_();
  removeStaleUsers_();
  closeDuplicates_();
  props.setProperty('kindsVersion', '9');
  if (n) console.log('예전 구분 ' + n + '건을 등록 시각으로 다시 매겼습니다(정기예약·추가예약·기간전예약).');
  if (memo) console.log('사용 시작 뒤 제목을 바꾼 메모 ' + memo + '건을 원래 예약자로 바로잡았습니다.');
}

/**
 * 예전 코드는 사용 시작 뒤 제목 변경(예: '[Fix] Evaporator' → 'Evaporator-Completed')을 양도로 적었다.
 * 지금 규칙(메모, 예약자·구분 그대로)에 맞게 넘겨받은 행을 원래 예약자·구분·등록 시각으로 되돌린다. 반환: 고친 수
 */
function repairMemoTransfers_() {
  const all = Store.all();
  const handed = all.filter(a => a.status === STATUS.TRANSFERRED && a.cancelled !== null && a.cancelled >= a.start)
    .sort((x, y) => x.cancelled - y.cancelled); // 메모를 여러 번 바꾼 것은 앞에서부터 차례로
  let n = 0;
  for (const a of handed) {
    const b = all.find(x => x !== a && x.calendarId === a.calendarId && x.eventId === a.eventId &&
      x.note.indexOf('양도 ←') >= 0 && a.note.split(' / ').indexOf('양도 → ' + x.booker) >= 0 && x.bookerKey !== a.bookerKey);
    if (!b) continue;
    b.booker = a.booker;
    b.bookerKey = a.bookerKey;
    b.kind = a.kind;
    b.created = a.created;
    b.lateFrom = lateCancelFrom(b.kind, b.start, CONFIG);
    if (b.status !== STATUS.ACTIVE && isExcludedKind(b.kind)) {
      b.late = false;
      b.lateReason = b.kind === KIND.CLASS ? '수업' : '점검';
    }
    b.note = addNote_(b.note, '사용 시작 뒤 제목 변경은 메모: 예약자 ' + a.booker + '(으)로 바로잡음');
    Store.save(b);
    n++;
  }
  return n;
}

/**
 * 「사용자」 시트에서 사람이 아닌 이름을 지운다: 별칭·이메일이 비었고, 어느 기록의 예약자도 아니며,
 * 캘린더 제목에서 읽힌 이름(예: '[Fix] Evaporator'의 Evaporator, 메모 제목)인 것만. 관리자가 직접 적은 이름은 남긴다.
 */
function removeStaleUsers_() {
  try {
    const aliases = Store.aliases();
    const strip = n => (n.slice(-CLASS_SUFFIX.length) === CLASS_SUFFIX ? n.slice(0, -CLASS_SUFFIX.length) : n);
    const all = Store.all();
    const bookers = new Set(all.map(r => bookerKeyOf(strip(r.booker))));
    const titled = new Set(all.map(r => bookerKeyOf(parseBooker(r.title, aliases) || '')).filter(Boolean));
    const stale = aliases.filter(u => !u.aliases.length && !u.email &&
      !bookers.has(bookerKeyOf(u.name)) && titled.has(bookerKeyOf(u.name))).map(u => u.name);
    const removed = Store.removeUsers(stale);
    if (removed.length) {
      console.log('「사용자」 시트에서 사람이 아닌 이름 ' + removed.length + '건을 정리했습니다.');
      logPersonalDetails_(removed.join(', '));
    }
  } catch (err) {
    console.error('「사용자」 시트 정리 실패.');
    logPersonalDetails_(String(err));
  }
}

/**
 * 「예약기록」 열을 사람이 보는 순서로 한 번 옮겨 적는다(원래 시트는 「예약기록_백업」으로 복사).
 * 그 뒤에 관리자가 열 순서를 바꾸면 그대로 둔다(기록은 열 제목으로 찾아 쓴다).
 */
function migrateColumns_() {
  const props = PropertiesService.getScriptProperties();
  const v = Number(props.getProperty('columnsVersion') || 0);
  if (v >= 4) return;
  if (v < 1 && Store.arrangeColumns()) {
    console.log('「예약기록」 열 순서를 바꿨습니다. 원래 시트는 「' + SHEETS.RESERVATIONS + '_백업」에 있습니다.');
  } else {
    highlightLateRows_(Store.sheet(SHEETS.RESERVATIONS), Store.columns()); // 2: 직전 취소 행을 빨간색으로(우리 규칙만 바꿈)
  }
  if (v === 3) correctRestore_(); // 4: 3판이 이미 되살린 시트는 백업과 다시 대조해 바로잡기
  else restoreCreated_();         // 3: 등록시각이 빈 기록을 백업에서(빈 칸이 없으면 아무것도 안 함)
  props.setProperty('columnsVersion', '4');
}

/**
 * 3판의 되살리기가 이미 돈 시트를 「예약기록_백업」과 다시 대조해 한 번 바로잡는다. 3판은 한 일정에 기록이 여럿일 때
 * (옮겼다 되돌림, 지웠다 되살림, 양도 등) 다른 행과 짝지어 등록시각을 넣거나, 그 때문에 구분·직전 취소를 다시 매기거나,
 * 지금 남은 예약을 기준으로 그사이 닫힌 예약의 양보를 판정할 수 있었다.
 * - 백업 뒤 새로 생긴 기록(등록시각이 백업의 가장 늦은 등록시각보다 늦음)은 건드리지 않는다.
 * - 백업 뒤 그대로인 행: 짝이 헷갈릴 수 있던 행만 백업 값(등록시각·구분·직전취소·제외사유·마감) 그대로
 * - 백업 뒤 바뀐 행: 바른 짝의 등록시각·구분, 그사이 닫힌 것은 취소 시각 기준으로 다시 판정
 * 바꾼 행은 로그와 관리자 메일로 알린다.
 */
function correctRestore_() {
  const m = Store.matchBackup();
  if (!m) return;
  const closed = r => r.status === STATUS.CANCELLED || r.status === STATUS.MOVED;
  const yn = r => (closed(r) ? (r.late ? 'Y' : 'N') + (r.lateReason ? '(' + r.lateReason + ')' : '') : '');
  const lines = [];
  const review = [];
  const todo = m.matches.filter(x => !(x.row.created && x.row.created > m.maxCreated));
  const before = new Map(todo.map(({ row: r }) => [r, { created: r.created, kind: r.kind, yn: yn(r) }]));
  const bkGeom = new Map(); // [fix] 기록 → 백업 당시 시간(백업 때 「예약」이던 행)
  // [fix] 1차: 등록시각·구분부터 모두 바로잡는다(판정은 다른 행의 등록시각에 기대므로 2차에서)
  for (const { row: r, was, same, rivals } of todo) {
    const v3Wrong = r.created !== was.created; // [fix] 3판이 같은 백업 행을 골랐으면 그 뒤 바뀐 구분·직전취소(수업 전환, 관리자 수정)는 그대로
    r.created = was.created;
    if (was.status === STATUS.ACTIVE) bkGeom.set(r, { start: was.start, end: was.end });
    if (same) {
      if (rivals && v3Wrong) {
        // [fix] 수업·점검은 제목에서 오므로 백업 값으로 되돌리지 않는다(백업 뒤 'for class'로 바꾼 예약)
        if (was.kind && !isExcludedKind(was.kind) && !isExcludedKind(r.kind)) r.kind = was.kind;
        r.lateFrom = lateCancelFrom(r.kind, r.start, CONFIG);
        if (closed(r)) { r.late = was.late; r.lateReason = was.lateReason; }
        r.windowStart = was.windowStart;
        r.windowEnd = was.windowEnd;
      }
    } else if (was.status === STATUS.ACTIVE) {
      if (was.kind && !isExcludedKind(was.kind) && !isExcludedKind(r.kind) && r.kind !== was.kind) {
        r.kind = was.kind;
        r.lateFrom = lateCancelFrom(r.kind, r.start, CONFIG);
      }
    }
    if (r.windowStart && r.created >= weekStartFor(r.start)) {
      r.windowStart = null;
      r.windowEnd = null;
    }
  }
  // [fix] 2차: 백업 뒤 닫힌 행을 그 시각 기준으로 다시 판정. 앞 순위의 시간이 백업 뒤 바뀌어(늘림·줄임) 지금 시간과
  // 백업 때 시간으로 결과가 갈리면 바꾸지 않고 「확인 필요」로 알린다
  const all = Store.all();
  const yields = (r, when, geom) => all.some(o => {
    if (o === r || o.eventId === r.eventId || o.calendarId !== r.calendarId) return false;
    if (!(o.created !== null && o.created <= when && (o.status === STATUS.ACTIVE || (o.cancelled !== null && o.cancelled > when)))) return false;
    const g = geom(o);
    return g.start < r.end && g.end > r.start && rankCompare(o, r) < 0 && !handedAfter_(all, o, when);
  });
  for (const { row: r, was, same } of todo) {
    if (same || was.status !== STATUS.ACTIVE || !closed(r) || !r.cancelled) continue;
    const now = yields(r, r.cancelled, o => o);
    const then = yields(r, r.cancelled, o => bkGeom.get(o) || o);
    if (now !== then) { review.push(r.booker + '  ' + fmtSlot(r.start, r.end) + '  ' + r.equipment + ' [' + r.status + ']: 직전취소 ' + yn(r) + ' 그대로(앞 순위 예약의 시간이 그 뒤 바뀜)'); continue; }
    judgeClose_(r, r.cancelled, true);
  }
  for (const { row: r } of todo) {
    const b = before.get(r);
    const after = { created: r.created, kind: r.kind, yn: yn(r) };
    if (b.created === after.created && b.kind === after.kind && b.yn === after.yn) continue;
    Store.save(r);
    const d = [];
    if (b.created !== after.created) d.push('등록시각 ' + (b.created ? fmtKstSec(b.created) : '(빈 칸)') + ' → ' + fmtKstSec(after.created));
    if (b.kind !== after.kind) d.push('구분 ' + b.kind + ' → ' + after.kind);
    if (b.yn !== after.yn) d.push('직전취소 ' + b.yn + ' → ' + after.yn);
    lines.push(r.booker + '  ' + fmtSlot(r.start, r.end) + '  ' + r.equipment + ' [' + r.status + ']: ' + d.join(', '));
  }
  refreshFlags_(null);
  Store.commit();
  const left = Store.all().filter(r => !r.created).length;
  const head = '「' + SHEETS.RESERVATIONS + '_백업」과 다시 대조해 기록 ' + lines.length + '건을 바로잡았습니다' +
    (left ? '(등록시각을 찾지 못한 기록 ' + left + '건 남음)' : '') + '.';
  const NL = String.fromCharCode(10);
  console.log(head);
  logPersonalDetails_((lines.length ? lines.join(NL) : '') + (review.length ? NL + '확인 필요:' + NL + review.join(NL) : ''));
  if (lines.length || left || review.length) {
    sendAdminMail_(CONFIG.SUBJECT_PREFIX + ' 예약기록 바로잡음 ' + lines.length + '건', head + NL + NL + lines.join(NL) +
      (review.length ? NL + NL + '확인 필요(바꾸지 않음):' + NL + review.join(NL) : '') +
      NL + NL + '바뀐 칸은 「예약기록」에서, 원래 값은 「' + SHEETS.RESERVATIONS + '_백업」에서 볼 수 있습니다.');
  }
}

/**
 * 1·2판은 1행 등록시각 제목 칸이 빈 시트를 옮길 때 등록시각을 비워 두었다. 「예약기록_백업」에서 되살리고,
 * 그동안 등록시각 없이 내린 판정(그사이 닫힌 예약의 직전 취소·양보, 구분, 위반 표시)을 다시 계산한다.
 */
function restoreCreated_() {
  const fixed = Store.restoreFromBackup();
  if (!fixed.length) {
    const left = Store.all().filter(r => !r.created).length;
    if (left) console.warn('등록시각이 빈 기록 ' + left + '건을 「' + SHEETS.RESERVATIONS + '_백업」에서 찾지 못했습니다(백업 시트 이름·열 제목 확인).');
    return;
  }
  let rejudged = 0;
  for (const { row: r, was } of fixed) {
    // 백업 뒤에 바뀐 구분(수업·점검 아님)은 되살린 등록시각으로 다시 매긴다
    if (was.kind && was.kind !== r.kind && !isExcludedKind(r.kind)) {
      r.kind = classifyBooking(r.created, r.start, false, null);
      r.lateFrom = lateCancelFrom(r.kind, r.start, CONFIG);
    }
    // 마감시작·마감종료는 주가 시작되기 전에 등록한 예약에만 붙는다(등록시각이 없을 때 잘못 붙은 것을 지움)
    if (r.windowStart && r.created >= weekStartFor(r.start)) {
      r.windowStart = null;
      r.windowEnd = null;
    }
    // 백업 때 예약이던 것이 그사이 취소·변경됐으면 직전 취소·양보를 다시 판정
    if ((was.status === STATUS.ACTIVE || !was.status) && (r.status === STATUS.CANCELLED || r.status === STATUS.MOVED) && r.cancelled) {
      judgeClose_(r, r.cancelled, true);
      rejudged++;
    }
    Store.save(r);
  }
  refreshFlags_(null);
  const left = Store.all().filter(r => !r.created).length;
  Store.commit();
  console.log('「' + SHEETS.RESERVATIONS + '_백업」에서 등록시각 ' + fixed.length + '건을 되살렸습니다' +
    (rejudged ? '(그사이 닫힌 ' + rejudged + '건은 직전 취소를 다시 판정)' : '') + '.' +
    (left ? ' 등록시각을 찾지 못한 기록 ' + left + '건이 남았습니다.' : ''));
}

/**
 * 같은 일정(캘린더·일정ID)에 「예약」 행이 둘 이상이면(예전 판이 남긴 기록) 하나만 남기고 나머지는 「중복」으로 닫는다.
 * 행은 지우지 않는다. 「중복」은 집계·브리핑·알림에서 빠진다. 남기는 행: 등록시각이 늦은 것, 같으면 비고가 긴 것
 */
function closeDuplicates_() {
  const groups = new Map();
  for (const r of Store.active()) {
    const k = r.calendarId + '|' + r.eventId;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  let n = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const keep = list.slice().sort((a, b) => (b.created || 0) - (a.created || 0) || b.note.length - a.note.length)[0];
    for (const r of list) {
      if (r === keep) continue;
      r.status = STATUS.DUPLICATE;
      r.violations = '';
      r.note = addNote_(r.note, '같은 일정의 기록이 둘이라 정리(남긴 기록 ' + fmtSlot(keep.start, keep.end) + ')');
      Store.save(r);
      n++;
    }
  }
  if (!n) return;
  Store.commit();
  console.log('같은 일정의 「예약」 기록이 둘 이상이던 ' + n + '건을 「중복」으로 정리했습니다(행은 남김).');
}

/** 예전 시트의 「늦은취소」 열 제목을 「직전취소」로 바꾼다 */
function renameLateHeaders_() {
  const ss = SpreadsheetApp.getActive();
  for (const name of [SHEETS.RESERVATIONS, SHEETS.WEEKLY]) {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastColumn() < 1) continue;
    const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    hdr.forEach((h, i) => { if (h === '늦은취소') sh.getRange(1, i + 1).setValue('직전취소'); });
  }
}

/** 지운 일정 먼저(같은 실행에서 지우고 다시 만든 예약을 알아보도록), 나머지는 등록 순 */
function processFetched_(fetched, errors) {
  const items = [];
  fetched.forEach(f => f.items.forEach(ev => items.push({ f, ev })));
  if (!items.length) return;
  closeDuplicates_(); // 같은 일정의 「예약」 행이 둘이면 바뀐 일정을 엉뚱한 행에 적지 않도록 먼저 정리
  const order = ev => Date.parse(ev.created || ev.updated || '') || 0;
  items.sort((a, b) => (b.ev.status === 'cancelled') - (a.ev.status === 'cancelled') || order(a.ev) - order(b.ev));

  const aliases = Store.aliases();
  const ctx = { closed: new Map(), fresh: new Map() };
  runFixes_ = [];
  // 이번 실행에 새로 나타난 시간 예약(같은 사람·같은 시간이면 지우고 다시 만든 같은 예약으로 본다)
  for (const { f, ev } of items) {
    const start = eventStartMs_(ev);
    if (ev.status === 'cancelled' || start === null || Store.findActive(f.eq.calendarId, ev.id)) continue;
    const key = freshKey_(f.eq.calendarId, start, Date.parse(ev.end.dateTime),
      bookerKeyOf(bookerName_(ev.summary, aliases) || fallbackBooker_(ev)));
    if (!ctx.fresh.has(key)) ctx.fresh.set(key, ev);
    if (isMaintenanceTitle_(ev.summary)) {
      runFixes_.push({ calendarId: f.eq.calendarId, eventId: ev.id, start, end: Date.parse(ev.end.dateTime),
        kind: KIND.MAINTENANCE, created: Date.parse(ev.created || ev.updated || '') || Date.now() });
    }
  }
  try {
    for (const { f, ev } of items) {
      try {
        handleEvent_(f, ev, ctx);
      } catch (err) {
        errors.push({ eq: f.eq, err, eventId: ev.id });
      }
    }
  } finally {
    runFixes_ = [];
  }
  for (const f of fetched) {
    if (f.full && !errors.some(e => e.eq.calendarId === f.eq.calendarId)) reconcileMissing_(f);
  }
  refreshFlags_(new Set(fetched.filter(f => f.items.length).map(f => f.eq.calendarId)));
}

/**
 * 위반 표시(「예약기록」 위반 칸)를 지금 기록 기준으로 다시 계산한다. 다른 예약이 옮겨지거나 지워져
 * 겹침이 풀리면 표시도 지운다. calIds: 바뀐 장비(없으면 전체). 하루 제한을 장비 합산으로 세면 전체를 본다.
 */
function refreshFlags_(calIds) {
  if (calIds && !calIds.size) return;
  const all = Store.active();
  const since = Date.now() - 7 * DAY_MS;
  for (const r of all) {
    if (r.end < since) continue;
    if (calIds && CONFIG.DAY_LIMIT_SCOPE !== 'ALL' && !calIds.has(r.calendarId)) continue;
    const v = checkViolations(r, all, CONFIG).join(' / ');
    if (v !== (r.violations || '')) {
      r.violations = v;
      Store.save(r);
    }
  }
}

const freshKey_ = (cal, s, e, who) => cal + '|' + s + '|' + e + '|' + who;

/** 한 캘린더의 변경 목록. 토큰이 없거나 만료(410)면 전체 목록(최근 INITIAL_SYNC_DAYS_BACK일부터). */
function fetchCalendar_(eq, opt) {
  const props = PropertiesService.getScriptProperties();
  const token = opt.full ? null : props.getProperty(tokenKey_(eq.calendarId));
  const fetchedAt = Date.now();
  const prevSync = Number(props.getProperty(lastSyncKey_(eq.calendarId))) || null;
  let res;
  let full = !token;
  try {
    res = listEvents_(eq.calendarId, token, fetchedAt);
  } catch (err) {
    if (!token || !/410|sync token|fullSyncRequired/i.test(String(err))) throw err;
    console.warn('동기화 토큰 만료: 전체 목록을 다시 읽습니다.');
    logPersonalDetails_('대상 장비: ' + eq.name);
    full = true;
    res = listEvents_(eq.calendarId, null, fetchedAt);
  }
  // 처음 보는 캘린더의 전체 목록은 조용히 기록하고, 기록이 있는 캘린더를 다시 읽을 때는 달라진 것만 알린다
  const notify = !!opt.notify && (!full || Store.hasCalendar(eq.calendarId));
  return {
    eq, items: res.items, nextSyncToken: res.next, full, fetchedAt, prevSync, notify,
    minStart: fetchedAt - CONFIG.INITIAL_SYNC_DAYS_BACK * DAY_MS
  };
}

function listEvents_(calendarId, token, now) {
  const items = [];
  let pageToken = null;
  let next = null;
  do {
    const o = { singleEvents: true, showDeleted: true, maxResults: 2500 };
    if (token) o.syncToken = token;
    else o.timeMin = new Date(now - CONFIG.INITIAL_SYNC_DAYS_BACK * DAY_MS).toISOString();
    if (pageToken) o.pageToken = pageToken;
    const resp = Calendar.Events.list(calendarId, o);
    for (const ev of resp.items || []) items.push(ev);
    pageToken = resp.nextPageToken;
    if (resp.nextSyncToken) next = resp.nextSyncToken;
  } while (pageToken);
  return { items, next };
}

const eventStartMs_ = ev => (ev.start && ev.start.dateTime ? Date.parse(ev.start.dateTime) : null);
const updatedMs_ = ev => (ev.updated ? Date.parse(ev.updated) : Date.now());
const addNote_ = (note, text) => (note ? note + ' / ' : '') + text;
const isFallbackName_ = name => String(name || '').indexOf('(제목 없음') === 0;
const isRepresentative_ = (name, aliases) => (aliases || []).some(u => u.name === name);
/** 반복 일정 회차의 ID('기본ID_20261013T030000Z' 꼴) — 지운 일정 응답에 recurringEventId가 없어도 알아본다 */
const isInstanceId_ = id => /_\d{8}(T\d{6}Z?)?$/.test(String(id));
const CLASS_SUFFIX = ' (수업)';
const MAINTENANCE_NAME = '점검';
const isClassTitle_ = title => !!CONFIG.CLASS_TITLE && CONFIG.CLASS_TITLE.test(String(title || ''));
const isMaintenanceTitle_ = title => !!CONFIG.MAINTENANCE_TITLE && CONFIG.MAINTENANCE_TITLE.test(String(title || ''));
/** 제목으로 정해지는 구분: 점검·수업예약, 아니면 null */
const specialKind_ = title => (isMaintenanceTitle_(title) ? KIND.MAINTENANCE : isClassTitle_(title) ? KIND.CLASS : null);

/** 제목의 예약자 이름. 수업 예약이면 ' (수업)'을 붙여 개인 사용과 따로 센다 */
function bookerName_(title, aliases) {
  if (isMaintenanceTitle_(title)) return MAINTENANCE_NAME;
  const name = parseBooker(title, aliases);
  return name && isClassTitle_(title) ? name + CLASS_SUFFIX : name;
}

/**
 * 지운 시각. 지운 일정은 id만 확실하므로 updated가 없으면 일정을 다시 읽고,
 * 그래도 모르면 지난 동기화 시각(지운 사람에게 유리한 쪽)으로 본다. known=false면 추정값
 */
function cancelTimeMs_(f, ev) {
  if (ev.updated) return { ms: Date.parse(ev.updated), known: true };
  try {
    const full = Calendar.Events.get(f.eq.calendarId, ev.id);
    if (full && full.updated) return { ms: Date.parse(full.updated), known: true };
  } catch (e) { /* 이미 완전히 지워짐 */ }
  return { ms: f.prevSync || f.fetchedAt, known: false };
}

/** 제목에서 이름을 못 읽을 때(비공개 일정 등): 사람마다 다른 키가 되도록 */
function fallbackBooker_(ev) {
  const who = ev.creator && ev.creator.email ? ev.creator.email : String(ev.id).slice(0, 8);
  return '(제목 없음 ' + who + ')';
}

function handleEvent_(f, ev, ctx) {
  const eq = f.eq;
  const active = Store.findActive(eq.calendarId, ev.id);

  if (ev.status === 'cancelled') {
    if (!active) return;
    // 같은 실행에서 같은 사람이 같은 시간으로 다시 만들었으면(반복 일정 나누기 포함) 같은 예약으로 이어 간다
    const key = freshKey_(active.calendarId, active.start, active.end, active.bookerKey);
    const nx = ctx.fresh.get(key);
    if (nx && nx.id !== active.eventId && !Store.findActive(eq.calendarId, nx.id)) {
      const oldKey = recordKey(active);
      active.eventId = nx.id;
      Outbox.rekey(oldKey, recordKey(active));
      active.note = addNote_(active.note, '같은 예약을 다시 만듦 ' + fmtKst(updatedMs_(nx)));
      Store.save(active);
      ctx.fresh.delete(key);
      return;
    }
    const c = cancelTimeMs_(f, ev);
    if (cancelBooking_(f, active, c.ms, ev)) ctx.closed.set(ev.id, active);
    return;
  }

  const start = eventStartMs_(ev);
  if (start === null) { // 종일 일정은 예약이 아니다. 시간 예약을 종일로 바꾸면 취소로 본다
    if (active) cancelBooking_(f, active, updatedMs_(ev), ev);
    return;
  }
  const end = Date.parse(ev.end.dateTime);
  if (!(end > start)) return;

  const aliases = Store.aliases();
  const parsed = bookerName_(ev.summary, aliases);
  if (active) return updateReservation_(f, ev, active, start, end, parsed, aliases);

  // 기록에 없는 일정
  if (end < f.minStart) return;                                   // 오래된 일정
  if (ev.recurringEventId && start > Date.now() + CONFIG.RECORD_HORIZON_DAYS * DAY_MS) return; // 먼 반복 인스턴스는 나중에 채움

  // 다른 장비 캘린더에서 옮겨 옴: 같은 실행에서 원래 쪽 삭제를 봤거나,
  // 이 캘린더가 주최자인데 다른 장비 캘린더에 같은 일정이 예약으로 남아 있음(원래 쪽을 아직 못 읽음)
  let moveFrom = ctx.closed.get(ev.id);
  if (moveFrom && moveFrom.calendarId === eq.calendarId) moveFrom = null;
  if (!moveFrom && ev.organizer && ev.organizer.email === eq.calendarId) {
    const other = Store.findByEvent(ev.id).find(r => r.status === STATUS.ACTIVE && r.calendarId !== eq.calendarId);
    if (other && cancelBooking_(f, other, updatedMs_(ev), ev)) moveFrom = other;
  }
  if (moveFrom) {
    // 원래 기록은 「변경」, 취소 알림 대신 변경 알림
    const when = updatedMs_(ev);
    moveFrom.status = STATUS.MOVED;
    moveFrom.note = addNote_(moveFrom.note, '장비 이동 → ' + eq.name + ' ' + fmtSlot(start, end));
    Store.save(moveFrom);
    Outbox.drop(recordKey(moveFrom));
    const r = newReservation_(eq, ev, start, end, when, parsed || moveFrom.booker);
    r.note = '장비 이동 ← ' + moveFrom.equipment;
    queue_(f, { type: 'change', key: recordKey(moveFrom) }, moveFrom, moveFrom.cancelled);
    noteNewBooking_(f, r, when, null);
    return;
  }

  // 등록 시각: 캘린더 기록(초 단위). 지웠다가 되살렸거나 다른 캘린더에서 옮겨 온 일정,
  // 지난 동기화 때도 있었지만 예약이 아니었던 일정(종일 → 시간 예약)은 지금 등록한 것으로 본다
  let created = ev.created ? Date.parse(ev.created) : Date.now();
  let note = '';
  if (Store.findByEvent(ev.id).some(r => r.calendarId === eq.calendarId || r.status !== STATUS.ACTIVE)) {
    created = updatedMs_(ev);
    note = '다시 등록';
  } else if (!f.full && f.prevSync && !ev.recurringEventId && created < f.prevSync - 60 * 1000) {
    created = updatedMs_(ev);
    note = '기록 없던 일정이 예약이 됨';
  }
  const r = newReservation_(eq, ev, start, end, created, parsed || fallbackBooker_(ev));
  r.note = note;
  noteNewBooking_(f, r, Math.max(created, updatedMs_(ev)), null);
}

/** 기록이 있는 일정이 바뀜: 제목·시간 */
function updateReservation_(f, ev, active, start, end, parsed, aliases) {
  const eq = f.eq;
  const when = updatedMs_(ev);
  const prevTitle = active.title;
  const prevName = bookerName_(prevTitle, aliases);
  // 같은 사람: 제목이 없음(비공개), 예전에 이름을 못 읽음, 같은 이름, 별칭을 나중에 추가, 이름 뒤에 덧붙임
  const sameName = !parsed || !prevName || isFallbackName_(active.booker) ||
    bookerKeyOf(parsed) === bookerKeyOf(prevName) || bookerKeyOf(parsed) === active.bookerKey ||
    extendsName(parsed, prevName) || extendsName(parsed, active.booker);
  // 사용이 시작된 뒤 제목을 바꾼 것은 메모(예: 'Evaporator-Completed')로 보고 예약자를 바꾸지 않는다(양도는 시작 전만)
  const annotation = !sameName && when >= active.start;
  const samePerson = sameName || annotation;
  const sameTime = active.start === start && active.end === end;
  const overlapsOld = start < active.end && end > active.start;

  if (samePerson) {
    if (!annotation && parsed && (isFallbackName_(active.booker) || (isRepresentative_(parsed, aliases) && parsed !== active.booker))) {
      active.booker = parsed;
      active.bookerKey = bookerKeyOf(parsed);
    }
    if (ev.summary) active.title = ev.summary;
    if (!annotation) syncClassKind_(active, ev, prevTitle); // 메모(사용 시작 뒤 제목 변경)는 구분도 그대로
    if (sameTime) { Store.save(active); return; }
    if (overlapsOld) { adjustReservation_(f, active, start, end, when); return; }
    // 겹치지 않는 시간으로 옮김(사용 시작 뒤에 옮겨도 같음): 원래 시간은 「변경」(직전 취소 판정), 새 시간은 옮긴 시각에 등록한 예약
    closeReservation_(active, STATUS.MOVED, when);
    const moved = newReservation_(eq, ev, start, end, when, active.booker);
    active.note = addNote_(active.note, '시간 변경 → ' + fmtSlot(start, end));
    moved.note = '시간 변경 ← ' + fmtSlot(active.start, active.end);
    Store.save(active);
    queue_(f, { type: 'change', key: recordKey(active) }, active, when);
    noteNewBooking_(f, moved, when, null);
    return;
  }

  if (!overlapsOld) {
    // 이름과 시간을 함께 바꿈: 원래 사람의 취소(직전 취소 판정) + 새 사람의 새 예약
    cancelBooking_(f, active, when, ev);
    active.note = addNote_(active.note, '→ ' + parsed + ' ' + fmtSlot(start, end));
    Store.save(active);
    const r = newReservation_(eq, ev, start, end, when, parsed);
    r.note = '← ' + active.booker + ' ' + fmtSlot(active.start, active.end);
    noteNewBooking_(f, r, when, null);
    return;
  }

  // 제목의 이름이 바뀜 = 양도. 원래 등록 시각·구분·순위를 이어받는다(슬롯은 비지 않으므로 메일 없음, 이행률에서 뺌)
  active.status = STATUS.TRANSFERRED;
  active.cancelled = when;
  active.late = false;
  active.lateReason = '';
  active.note = addNote_(active.note, '양도 → ' + parsed);
  Store.save(active);
  // 수업·점검 시간을 넘겨받으면 넘겨받은 시각에 등록한 예약으로 본다(수업·점검의 등록 시각·구분은 이어받지 않음)
  const fromExcluded = isExcludedKind(active.kind);
  const r = newReservation_(eq, ev, active.start, active.end, fromExcluded ? when : active.created, parsed,
    fromExcluded ? null : active);
  r.note = '양도 ← ' + active.booker + ' ' + fmtKst(when);
  if (!sameTime) adjustReservation_(f, r, start, end, when, active);
  else noteNewBooking_(f, r, when, active);
  if (fromExcluded) queueEarly_(f, r);
}

/**
 * 지우거나 종일로 바꾼 예약을 취소로 닫는다. 사용 시작 뒤에 지워도 직전 취소로 판정한다.
 * 예외: 이미 끝난 반복 일정 회차가 시리즈째 지워진 것은 지난 기록 정리로 보고 이행으로 둔다.
 * 반환: 취소로 닫았으면 true
 */
function cancelBooking_(f, row, when, ev) {
  if (when >= row.end && ((ev && ev.recurringEventId) || isInstanceId_(row.eventId))) {
    row.note = addNote_(row.note, '끝난 회차가 반복 일정째 지워짐 ' + fmtKst(when));
    Store.save(row);
    return false;
  }
  closeReservation_(row, STATUS.CANCELLED, when);
  queue_(f, { type: 'cancel', key: recordKey(row) }, row, when);
  return true;
}

/** 취소·변경으로 닫는다. 중복 예약의 후순위가 정리한 것(앞 순위와 겹침)은 직전 취소로 세지 않는다 */
function closeReservation_(r, status, when) {
  r.status = status;
  r.cancelled = when;
  judgeClose_(r, when);
  Store.save(r);
}

/**
 * [verify] o가 when 뒤의 양도로 생긴 행인지: 같은 일정에 o와 등록시각이 같은 「양도」 행이 when 뒤에(그리고 o가 닫히기 전에) 닫혔다.
 * 양도로 생긴 행은 넘겨준 행의 등록시각을 이어받으므로 등록시각만으로는 when에 있던 예약처럼 보인다.
 */
function handedAfter_(all, o, when) {
  return all.some(p => p !== o && p.status === STATUS.TRANSFERRED && p.calendarId === o.calendarId && p.eventId === o.eventId &&
    p.created === o.created && p.cancelled !== null && p.cancelled > when &&
    (o.status === STATUS.ACTIVE || o.cancelled === null || p.cancelled < o.cancelled));
}

/** 닫은 기록(취소·변경)의 직전 취소 판정: 양보(앞 순위와 겹침) / 수업·점검 / 직전 취소·유예 */
function judgeClose_(r, when, asOf) {
  const higher = o => o !== r && o.eventId !== r.eventId && overlaps(o, r) && rankCompare(o, r) < 0;
  // asOf: 지난 취소를 다시 판정할 때는 그 시각에 있던 예약만 본다(그 뒤에 생긴 점검·그 뒤에 닫힌 앞 순위)
  const held = o => o.created !== null && o.created <= when && (o.status === STATUS.ACTIVE || (o.cancelled !== null && o.cancelled > when));
  // [verify] 그 시각 뒤 양도로 생긴 행은 넘겨준 사람의 등록시각을 이어받으므로 빼고, 넘겨준 행(양도, 그 뒤 닫힘)을 그 시각의 예약으로 본다
  const all = asOf ? Store.all() : null;
  const pool = asOf ? all.filter(o => held(o) && overlaps(o, r) && !handedAfter_(all, o, when)) : Store.active();
  // 같은 주기에 새로 생긴 점검은 아직 기록 전이라 따로 본다(지운 뒤에 생긴 점검은 양보가 아님)
  const yields = pool.some(higher) || runFixes_.some(o => higher(o) && o.created <= when);
  if (yields) {
    r.late = false;
    r.lateReason = '양보';
  } else if (isExcludedKind(r.kind)) {
    r.late = false;
    r.lateReason = r.kind === KIND.CLASS ? '수업' : '점검';
  } else {
    r.late = isLateCancel(r.kind, r.created, r.start, when, CONFIG);
    r.lateReason = !r.late && when >= r.lateFrom && withinGrace(r.created, when, CONFIG) ? '유예' : '';
  }
}

/**
 * 같은 예약의 시간 조정(원래 시간과 겹침). prev: 비교할 원래 시간(양도면 원래 기록)
 * - 시작 전에 내놓은 시간이 있으면 「일부 취소」 알림(직전 취소로 세지 않음)
 * - 월 09:00 뒤 처음 바꾸는 정기예약은 기간이 끝날 때의 시간을 남긴다(하루 제한은 그 시간으로 판정)
 */
function adjustReservation_(f, r, start, end, when, prev) {
  const old = prev || { calendarId: r.calendarId, eventId: r.eventId, start: r.start, end: r.end };
  const freed = when < old.start ? freedParts_(old.start, old.end, start, end, when) : [];
  const ws = weekStartFor(r.start);
  if (!r.windowStart && !isExcludedKind(r.kind) && r.created < ws && when >= ws) {
    r.windowStart = old.start;
    r.windowEnd = old.end;
  }
  r.note = addNote_(r.note, (when >= old.start ? '사용 중 시간 수정 ' : '시간 조정 ') +
    fmtSlot(old.start, old.end) + ' → ' + fmtSlot(start, end));
  const oldKey = recordKey(r);
  r.start = start;
  r.end = end;
  if (!prev) Outbox.rekey(oldKey, recordKey(r)); // 양도면 원래 예약자의 알림을 옮기지 않는다
  r.lateFrom = lateCancelFrom(r.kind, start, CONFIG);
  r.violations = checkViolations(r, Store.active(), CONFIG).join(' / ');
  Store.save(r);
  if (freed.length) queue_(f, { type: 'release', key: recordKey(r) }, r, when);
  if (when < r.end) noteNewBooking_(f, r, when, old);
}

/** 원래 시간 중 새 시간에 들지 않고 아직 지나지 않은 부분 [[s, e], ...] */
function freedParts_(os, oe, ns, ne, now) {
  const parts = [];
  if (ns > os) parts.push([os, Math.min(oe, ns)]);
  if (ne < oe) parts.push([Math.max(os, ne), oe]);
  return parts.map(p => [Math.max(p[0], now), p[1]]).filter(p => p[1] > p[0]);
}

/** 제목이 수업·점검 ↔ 개인 사용으로 바뀌면 구분을 맞춘다 */
function syncClassKind_(r, ev, prevTitle) {
  const special = specialKind_(ev.summary);
  if (!ev.summary || special === (isExcludedKind(r.kind) ? r.kind : null)) return;
  // 수업·점검이 아닌 제목인데 원래 제목도 그랬다면(점검에 사용 뒤 메모 제목을 단 뒤 다시 고침) 구분은 그대로
  if (!special && !specialKind_(prevTitle)) return;
  r.kind = classifyBooking(r.created, r.start, !!ev.recurringEventId, special);
  r.lateFrom = lateCancelFrom(r.kind, r.start, CONFIG);
  r.violations = checkViolations(r, Store.active(), CONFIG).join(' / ');
}

/** inherit: 양도로 이어받을 원래 기록(등록 구분·순위·기간 끝 시간) */
function newReservation_(eq, ev, start, end, created, booker, inherit) {
  const special = specialKind_(ev.summary);
  const kind = special || (inherit && !isExcludedKind(inherit.kind) ? inherit.kind :
    classifyBooking(created, start, !!ev.recurringEventId, null));
  const r = {
    equipment: eq.name,
    calendarId: eq.calendarId,
    eventId: ev.id,
    booker,
    bookerKey: bookerKeyOf(booker),
    title: ev.summary || '',
    start, end, created, kind,
    status: STATUS.ACTIVE,
    cancelled: null,
    late: false,
    lateFrom: lateCancelFrom(kind, start, CONFIG),
    creator: ev.creator && ev.creator.email ? ev.creator.email : '',
    note: '',
    windowStart: inherit ? inherit.windowStart || null : null,
    windowEnd: inherit ? inherit.windowEnd || null : null,
    lateReason: ''
  };
  r.violations = checkViolations(r, Store.active(), CONFIG).join(' / ');
  return Store.append(r);
}

/**
 * 그룹에 바로 알릴 것을 쌓는다: 이번 주(월 09:00에 시작한 주) 슬롯의 「직전 취소」뿐이다.
 * 정상 취소·변경·일부 취소는 메일 없이 기록만 한다.
 */
function queue_(f, item, row, when) {
  const now = Date.now();
  if (!f.notify || !CONFIG.NOTIFY.LAST_MINUTE_CANCEL || row.end <= now) return;
  if ((item.type !== 'cancel' && item.type !== 'change') || !row.late) return;
  const ws = weekStartFor(row.start);
  if (now < ws) return;
  if (when < ws && Number(PropertiesService.getScriptProperties().getProperty('briefingWeek') || 0) < ws) return;
  item.at = when;
  item.queuedAt = Date.now();
  Outbox.add(item);
}

/** 기간전예약이 새로 생기면 예약자에게 개인 메일(이번 주 슬롯 제한 없이 바로) */
function queueEarly_(f, r) {
  if (!f.notify || !CONFIG.NOTIFY.EARLY_TO_BOOKER || r.kind !== KIND.EARLY || r.end <= Date.now()) return;
  Outbox.add({ type: 'early', key: recordKey(r), at: Date.now(), queuedAt: Date.now() });
}

/** 새로 생긴 예약(prev 없음)이 기간전예약이면 예약자 개인 알림. 중복 예약은 메일 없이 월요일 브리핑에서 본다 */
function noteNewBooking_(f, r, when, prev) {
  if (!prev) queueEarly_(f, r);
}

/**
 * 전체 목록에 더 이상 없는 일정(오래전에 지워져 목록에서도 사라짐): 지난 동기화 뒤에 지운 것으로 본다.
 */
function reconcileMissing_(f) {
  const seen = new Set(f.items.map(ev => ev.id));
  const when = f.prevSync || f.fetchedAt;
  for (const r of Store.active()) {
    if (r.calendarId !== f.eq.calendarId || seen.has(r.eventId) || r.end < f.minStart) continue;
    if (isInstanceId_(r.eventId) && r.start > f.fetchedAt + CONFIG.RECORD_HORIZON_DAYS * DAY_MS) continue;
    cancelBooking_(f, r, when, null);
  }
}

/**
 * 하루 한 번: 앞으로 RECORD_HORIZON_DAYS일 안에 새로 든 반복 일정 인스턴스를 알림 없이 기록한다.
 * (반복이 아닌 새 일정은 동기화가 처리하므로 건드리지 않는다 — 중복 알림이 빠지지 않게)
 */
function fillHorizonDaily_(opt, t0, errors) {
  const props = PropertiesService.getScriptProperties();
  const today = usageDayKey(Date.now());
  if (!opt.onlyNew && props.getProperty('horizonDay') === today) return;
  if (Date.now() - t0 > TIME_BUDGET_MS) return;
  const now = Date.now();
  let ok = true;
  const filled = new Set();
  for (const eq of Store.equipments()) {
    if (!props.getProperty(tokenKey_(eq.calendarId))) continue;
    try {
      const f = { eq, notify: false, full: false, fetchedAt: now, prevSync: null, minStart: now - DAY_MS };
      let pageToken = null;
      do {
        const o = {
          singleEvents: true, showDeleted: false, maxResults: 2500,
          timeMin: new Date(now).toISOString(),
          timeMax: new Date(now + (CONFIG.RECORD_HORIZON_DAYS + 1) * DAY_MS).toISOString()
        };
        if (pageToken) o.pageToken = pageToken;
        const resp = Calendar.Events.list(eq.calendarId, o);
        for (const ev of resp.items || []) {
          if (!ev.recurringEventId || ev.status === 'cancelled' || eventStartMs_(ev) === null) continue;
          if (Store.findByEvent(ev.id).length) continue;
          handleEvent_(f, ev, { closed: new Map(), fresh: new Map() });
          filled.add(eq.calendarId);
        }
        pageToken = resp.nextPageToken;
      } while (pageToken);
    } catch (err) {
      ok = false;
      errors.push({ eq, err });
    }
  }
  refreshFlags_(filled);
  Store.commit();
  addNewUsers_();
  if (ok) props.setProperty('horizonDay', today);
}

/**
 * 새로 본 예약자 이름을 「사용자」 시트에 더한다(같은 사람의 다른 표기는 관리자가 별칭 칸에 묶는다).
 * 수업 예약의 ' (수업)'은 떼고, 제목에서 이름을 못 읽은 기록은 넣지 않는다.
 */
function addNewUsers_() {
  return addUserNames_(Store.takeNewNames());
}

function addUserNames_(bookers) {
  const names = bookers
    .filter(n => n && !isFallbackName_(n) && n !== MAINTENANCE_NAME)
    .map(n => (n.slice(-CLASS_SUFFIX.length) === CLASS_SUFFIX ? n.slice(0, -CLASS_SUFFIX.length) : n));
  try {
    const added = Store.addUsers(names);
    if (added.length) {
      console.log('「사용자」 시트에 새 이름 ' + added.length + '건을 추가했습니다.');
      logPersonalDetails_(added.join(', '));
    }
    return added;
  } catch (err) {
    console.error('「사용자」 시트에 이름을 추가하지 못했습니다.');
    logPersonalDetails_(String(err));
    return [];
  }
}

/** 동기화 오류: 로그에 남기고, 같은 캘린더는 하루 한 번만 관리자에게 메일(보내는 데 성공했을 때만 표시) */
function reportErrors_(errors) {
  if (!errors.length) return;
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const lines = [];
  const keys = [];
  for (const e of errors) {
    const msg = '[' + e.eq.name + '] ' + (e.eventId ? '일정 ' + e.eventId + ' 처리 실패: ' : '동기화 실패: ') + e.err;
    console.error('캘린더 동기화 오류. 관리자 알림을 확인하세요.');
    logPersonalDetails_(msg);
    const key = 'errMail:' + e.eq.calendarId;
    if (now - Number(props.getProperty(key) || 0) < DAY_MS || keys.indexOf(key) >= 0) continue;
    keys.push(key);
    lines.push(msg);
  }
  if (lines.length && sendAdminMail_(CONFIG.SUBJECT_PREFIX + ' 동기화 오류', lines.join('\n') +
      '\n\n캘린더 공유 권한, 「장비」 시트의 캘린더ID를 확인하세요. 같은 오류는 하루 한 번만 알립니다.')) {
    keys.forEach(k => props.setProperty(k, String(now)));
  }
}
