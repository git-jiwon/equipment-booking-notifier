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

/** 지운 일정 먼저(같은 실행에서 지우고 다시 만든 예약을 알아보도록), 나머지는 등록 순 */
function processFetched_(fetched, errors) {
  const items = [];
  fetched.forEach(f => f.items.forEach(ev => items.push({ f, ev })));
  // 빈 전체 목록도 기존 예약과 대조해야 마지막 일정의 삭제를 놓치지 않는다.
  if (!items.length && !fetched.some(f => f.full)) return;
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
  refreshFlags_(new Set(fetched.filter(f => f.items.length || f.full).map(f => f.eq.calendarId)));
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

/**
 * 취소·변경으로 닫고 직전 취소를 판정한다: 양보(앞 순위와 겹침) / 수업·점검 / 직전 취소·유예.
 * 중복 예약의 후순위가 정리한 것(앞 순위와 겹침)은 직전 취소로 세지 않는다.
 */
function closeReservation_(r, status, when) {
  const higher = o => o !== r && o.eventId !== r.eventId && overlaps(o, r) && rankCompare(o, r) < 0;
  // 같은 주기에 새로 생긴 점검은 아직 기록 전이라 따로 본다(지운 뒤에 생긴 점검은 양보가 아님)
  const yields = Store.active().some(higher) || runFixes_.some(o => higher(o) && o.created <= when);
  r.status = status;
  r.cancelled = when;
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
  Store.save(r);
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
