// node tests/rules.test.js — Rules.gs 규칙 계산 검사
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Rules.gs'), 'utf8');
const m = { exports: {} };
new Function('module', src)(m);
const R = m.exports;

const kst = s => Date.parse(s + '+09:00');
const cfg = {
  PRIORITY_LATE_FROM: 'WEEK_START', ADDITIONAL_LATE_DAY: 'USAGE_DAY', GRACE_MINUTES: 10,
  PRIORITY_SESSIONS_PER_DAY: 1, DAY_LIMIT_SCOPE: 'EQUIPMENT', CHECK_SLOT_ALIGNMENT: false
};
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

// 2026-10-12는 월요일
t('주 시작: 수요일 → 월 09:00', () =>
  assert.strictEqual(R.weekStartFor(kst('2026-10-14T10:00')), kst('2026-10-12T09:00')));
t('주 시작: 월 05:00(일요일 밤 24~09 세션) → 전 주', () =>
  assert.strictEqual(R.weekStartFor(kst('2026-10-12T05:00')), kst('2026-10-05T09:00')));
t('주 시작: 월 09:00 정각 → 그 주', () =>
  assert.strictEqual(R.weekStartFor(kst('2026-10-12T09:00')), kst('2026-10-12T09:00')));
t('주 시작: 다음 월 08:59 → 그 주', () =>
  assert.strictEqual(R.weekStartFor(kst('2026-10-19T08:59')), kst('2026-10-12T09:00')));
t('예약 시작 = 일 18:00', () =>
  assert.strictEqual(R.bookingOpenFor(kst('2026-10-12T09:00')), kst('2026-10-11T18:00')));

const wed15 = kst('2026-10-14T15:00');
t('구분: 일 19:00 등록 → 정기예약', () =>
  assert.strictEqual(R.classifyBooking(kst('2026-10-11T19:00'), wed15), R.KIND.PRIORITY));
t('구분: 일 17:59 등록 → 기간전예약', () =>
  assert.strictEqual(R.classifyBooking(kst('2026-10-11T17:59'), wed15), R.KIND.EARLY));
t('구분: 월 09:00 등록 → 추가예약', () =>
  assert.strictEqual(R.classifyBooking(kst('2026-10-12T09:00'), wed15), R.KIND.ADDITIONAL));

t('정기예약 직전 취소 기준 = 월 09:00', () =>
  assert.strictEqual(R.lateCancelFrom(R.KIND.PRIORITY, wed15, cfg), kst('2026-10-12T09:00')));
t('정기예약 BOOKING_OPEN 기준 = 일 18:00', () =>
  assert.strictEqual(R.lateCancelFrom(R.KIND.PRIORITY, wed15, { ...cfg, PRIORITY_LATE_FROM: 'BOOKING_OPEN' }), kst('2026-10-11T18:00')));
t('정기예약: 월 08:30 취소는 정상, 월 09:30 취소는 늦음', () => {
  const c = kst('2026-10-11T19:00');
  assert.strictEqual(R.isLateCancel(R.KIND.PRIORITY, c, wed15, kst('2026-10-12T08:30'), cfg), false);
  assert.strictEqual(R.isLateCancel(R.KIND.PRIORITY, c, wed15, kst('2026-10-12T09:30'), cfg), true);
});
t('추가예약: 수 15시 세션 → 수 09:00부터 늦음', () => {
  const c = kst('2026-10-12T10:00');
  assert.strictEqual(R.lateCancelFrom(R.KIND.ADDITIONAL, wed15, cfg), kst('2026-10-14T09:00'));
  assert.strictEqual(R.isLateCancel(R.KIND.ADDITIONAL, c, wed15, kst('2026-10-13T23:00'), cfg), false);
  assert.strictEqual(R.isLateCancel(R.KIND.ADDITIONAL, c, wed15, kst('2026-10-14T09:10'), cfg), true);
});
const thu00 = kst('2026-10-15T00:00'); // 수요일 24:00~09:00 세션
t('추가예약 24~09 세션: 사용일 기준 = 수 09:00, 달력 기준 = 목 00:00', () => {
  assert.strictEqual(R.lateCancelFrom(R.KIND.ADDITIONAL, thu00, cfg), kst('2026-10-14T09:00'));
  assert.strictEqual(R.lateCancelFrom(R.KIND.ADDITIONAL, thu00, { ...cfg, ADDITIONAL_LATE_DAY: 'CALENDAR_DAY' }), thu00);
});
t('유예: 등록 5분 뒤 취소는 직전 취소 아님', () =>
  assert.strictEqual(R.isLateCancel(R.KIND.ADDITIONAL, kst('2026-10-14T10:00'), wed15, kst('2026-10-14T10:05'), cfg), false));
t('유예 지나면 당일 취소는 늦음', () =>
  assert.strictEqual(R.isLateCancel(R.KIND.ADDITIONAL, kst('2026-10-14T10:00'), wed15, kst('2026-10-14T10:30'), cfg), true));

t('세션 수', () => {
  assert.strictEqual(R.sessionsCovered(kst('2026-10-14T09:00'), kst('2026-10-14T12:00')), 1);
  assert.strictEqual(R.sessionsCovered(kst('2026-10-14T09:00'), kst('2026-10-14T15:00')), 2);
  assert.strictEqual(R.sessionsCovered(kst('2026-10-14T21:00'), kst('2026-10-15T09:00')), 2);
  assert.strictEqual(R.sessionsCovered(kst('2026-10-15T00:00'), kst('2026-10-15T09:00')), 1);
});
t('세션 수: 경계와 안 맞는 예약은 3시간 단위 올림', () => {
  assert.strictEqual(R.sessionsCovered(kst('2026-10-14T19:00'), kst('2026-10-14T22:00')), 1);
  assert.strictEqual(R.sessionsCovered(kst('2026-10-14T13:30'), kst('2026-10-14T18:00')), 2);
  assert.strictEqual(R.sessionsCovered(kst('2026-10-14T21:00'), kst('2026-10-14T23:00')), 1);
});
t('제목에서 예약자', () => {
  const cases = {
    'UserA (BCP)': 'UserA', 'UserB(Ag)': 'UserB', 'UserC for class': 'UserC',
    'UserC for class - 마바사': '마바사', 'UserC for 마바사': '마바사', 'UserC for class': 'UserC', 'UserA - BCP': 'UserA',
    'UserC for class - User K (Ag)': 'User K', 'UserC for UserA': 'UserC', 'UserI': 'UserI', 'UserD': 'UserD', 'UserE(AFM)': 'UserE',
    '다라마 Example Lab (12-3시 only Fume hood)': '다라마 Example Lab', 'usera (Ag)': 'Usera', '  UserF(Ag) ': 'UserF'
  };
  for (const [title, want] of Object.entries(cases)) assert.strictEqual(R.parseBooker(title, []), want, title);
  const al = [{ name: '가나다', aliases: ['UserA', '나다'] }, { name: '다라마 Example Lab', aliases: ['다라마'] }];
  assert.strictEqual(R.parseBooker('usera (BCP)', al), '가나다');
  assert.strictEqual(R.parseBooker('나다(Ag)', al), '가나다');
  assert.strictEqual(R.parseBooker('다라마 교수님 (Fume hood)', al), '다라마 Example Lab');
  assert.strictEqual(R.parseBooker('UserAextra', al), 'UserAextra'); // 별칭 뒤에 글자가 이어지면 다른 이름
  assert.strictEqual(R.bookerKeyOf(' UserA  '), 'usera');
});
t('세션 경계', () => {
  assert.strictEqual(R.isSlotAligned(kst('2026-10-14T15:00'), kst('2026-10-14T18:00')), true);
  assert.strictEqual(R.isSlotAligned(kst('2026-10-15T00:00'), kst('2026-10-15T09:00')), true);
  assert.strictEqual(R.isSlotAligned(kst('2026-10-14T15:30'), kst('2026-10-14T18:00')), false);
});

const base = { calendarId: 'A', bookerKey: '가', booker: '가', kind: R.KIND.PRIORITY };
t('위반: 정기예약 기간 같은 날 두 세션', () => {
  const o = { ...base, eventId: '1', start: kst('2026-10-14T09:00'), end: kst('2026-10-14T12:00'), created: kst('2026-10-11T18:05') };
  const r = { ...base, eventId: '2', start: kst('2026-10-14T21:00'), end: kst('2026-10-15T00:00'), created: kst('2026-10-11T18:10') };
  assert.ok(R.checkViolations(r, [o], cfg).some(v => v.includes('세션 초과')));
  // 같은 사용일(수 09:00~목 09:00)의 24~09 세션도 같은 날
  const r2 = { ...r, start: kst('2026-10-15T00:00'), end: kst('2026-10-15T09:00') };
  assert.ok(R.checkViolations(r2, [o], cfg).some(v => v.includes('세션 초과')));
  // 다른 장비면 EQUIPMENT 범위에서는 위반 아님
  assert.ok(!R.checkViolations({ ...r, calendarId: 'B' }, [o], cfg).some(v => v.includes('세션 초과')));
  // 월 09:00 이후 추가 예약이면 위반 아님
  assert.deepStrictEqual(R.checkViolations({ ...r, created: kst('2026-10-12T09:30'), kind: R.KIND.ADDITIONAL }, [o], cfg), []);
});
t('위반: 시간 겹침', () => {
  const o = { calendarId: 'A', bookerKey: '나', booker: '나', eventId: '1', start: kst('2026-10-14T09:00'), end: kst('2026-10-14T12:00'), created: kst('2026-10-12T10:00') };
  const r = { ...base, eventId: '2', kind: R.KIND.ADDITIONAL, start: kst('2026-10-14T09:00'), end: kst('2026-10-14T12:00'), created: kst('2026-10-12T11:00') };
  assert.ok(R.checkViolations(r, [o], cfg).some(v => v.includes('겹침(나)')));
});
t('주간 통계: 이행률 = 이행 / (이행 + 직전 취소)', () => {
  const now = kst('2026-10-19T09:30');
  const rows = [
    { bookerKey: '가', booker: '가', status: '예약', start: kst('2026-10-13T09:00') },
    { bookerKey: '가', booker: '가', status: '예약', start: kst('2026-10-14T09:00') },
    { bookerKey: '가', booker: '가', status: '취소', late: true, start: kst('2026-10-15T09:00') },
    { bookerKey: '가', booker: '가', status: '취소', late: false, start: kst('2026-10-16T09:00') }
  ];
  const [p] = R.summarizeWeek(rows, now);
  assert.strictEqual(p.used.length, 2);
  assert.strictEqual(p.late, 1);
  assert.strictEqual(p.normal, 1);
  assert.ok(Math.abs(p.rate - 2 / 3) < 1e-9);
});
t('표기', () => {
  assert.strictEqual(R.fmtSlot(kst('2026-10-14T21:00'), kst('2026-10-15T00:00')), '10/14(수) 21:00–24:00');
});
t('반복 일정도 등록 시각으로 구분', () => {
  assert.strictEqual(R.classifyBooking(kst('2026-10-11T18:00:29'), wed15, true), R.KIND.PRIORITY);   // 정기예약 기간에 만든 반복 일정
  assert.strictEqual(R.classifyBooking(kst('2026-10-11T18:00:29'), wed15 + 7 * 86400e3, true), R.KIND.EARLY); // 다음 주 회차
  assert.strictEqual(R.classifyBooking(kst('2026-09-01T10:00'), wed15, true), R.KIND.EARLY);
  assert.strictEqual(R.classifyBooking(kst('2026-09-01T10:00'), wed15, true, true), R.KIND.CLASS);  // 수업은 수업예약
});
t('중복 예약 우선순위: 캘린더 등록 순(초 단위)', () => {
  const mk = (id, name, kind, created, s, e) => ({ calendarId: 'A', eventId: id, booker: name, kind,
    created: kst(created), start: kst(s), end: kst(e) });
  const a = mk('a', 'UserA', R.KIND.PRIORITY, '2026-10-11T18:00:41', '2026-10-14T09:00', '2026-10-14T12:00');
  const b = mk('b', 'UserB', R.KIND.PRIORITY, '2026-10-11T18:00:03', '2026-10-14T10:00', '2026-10-14T13:00');
  const c = mk('c', 'UserE', R.KIND.EARLY, '2026-10-10T10:00', '2026-10-14T11:00', '2026-10-14T12:00');
  const d = mk('d', 'UserD', R.KIND.ADDITIONAL, '2026-10-12T10:00', '2026-10-14T15:00', '2026-10-14T18:00');
  const other = { ...a, calendarId: 'B', eventId: 'z' };
  const g = R.conflictGroups([a, b, c, d, other]);
  assert.strictEqual(g.length, 1);
  assert.deepStrictEqual(g[0].map(r => r.booker), ['UserE', 'UserB', 'UserA']); // 캘린더 등록 순만(기간전예약도 같은 기준)
  assert.strictEqual(R.fmtKstSec(kst('2026-10-11T18:00:03')), '10/11(일) 18:00:03');
  // 늘린 예약도 등록 시각으로 순위(rankAt은 쓰지 않음)
  const ext = { ...a, eventId: 'x', rankAt: kst('2026-10-13T10:00') };
  assert.deepStrictEqual(R.conflictGroups([ext, b]).map(g => g.map(r => r.booker))[0], ['UserB', 'UserA']);
  // 이어진 겹침: 앞 순위와 직접 겹치지 않으면 양보할 필요 없음
  const p1 = mk('p1', 'UserD', R.KIND.ADDITIONAL, '2026-10-12T10:00:01', '2026-10-16T13:00', '2026-10-16T15:00');
  const p2 = mk('p2', 'UserB', R.KIND.ADDITIONAL, '2026-10-12T10:00:02', '2026-10-16T09:00', '2026-10-16T12:00');
  const p3 = mk('p3', 'UserA', R.KIND.ADDITIONAL, '2026-10-12T10:00:03', '2026-10-16T11:00', '2026-10-16T14:00');
  const gg = R.conflictGroups([p1, p2, p3])[0];
  assert.deepStrictEqual(gg.map(r => r.booker), ['UserD', 'UserB', 'UserA']);
  assert.deepStrictEqual([0, 1, 2].map(i => R.higherOverlaps(gg, i).map(r => r.booker)), [[], [], ['UserD', 'UserB']]);
  // 끝과 시작이 맞닿은 것은 겹침이 아님
  assert.strictEqual(R.conflictGroups([a, mk('e', 'X', R.KIND.PRIORITY, '2026-10-11T19:00', '2026-10-14T12:00', '2026-10-14T15:00')]).length, 0);
});
t('제목 변형', () => {
  const cases = {
    '[AFM] UserE': 'UserE', '(Ag) UserB': 'UserB', 'UserA 12:00-15:00': 'UserA', '12:00-15:00 UserA': 'UserA',
    'UserA 3-6시': 'UserA', 'UserA & UserB': 'UserA', 'UserA + UserB': 'UserA', '🔬 UserA': 'UserA',
    'UserA: BCP': 'UserA', '': '', '   ': '', '(BCP)': ''
  };
  for (const [title, want] of Object.entries(cases)) assert.strictEqual(R.parseBooker(title, []), want, title);
  assert.strictEqual(R.bookerKeyOf('가 나다'), R.bookerKeyOf('가나다'));
  const al = [{ name: 'UserJ', aliases: [] }, { name: 'UserE', aliases: [] }];
  assert.strictEqual(R.parseBooker('UserJ-min', al), 'UserJ-min');   // 별칭 뒤 '-글자'는 다른 이름
  assert.strictEqual(R.parseBooker('UserE AFM', al), 'UserE');        // 시트에 있는 이름으로 시작
  assert.strictEqual(R.parseBooker('UserC for UserE', al), 'UserE');  // for 뒤가 시트에 있는 사람
});
t('이름 덧붙임은 같은 사람', () => {
  assert.strictEqual(R.extendsName('UserD sample B', 'UserD'), true);
  assert.strictEqual(R.extendsName('UserD', 'UserD'), true);
  assert.strictEqual(R.extendsName('UserDk', 'UserD'), false);
  assert.strictEqual(R.extendsName('UserJ-min', 'UserJ'), false);
});
t('하루 제한은 월 09:00 때의 시간으로', () => {
  const r = { calendarId: 'A', bookerKey: 'usera', booker: 'UserA', eventId: 'w', kind: R.KIND.PRIORITY,
    start: kst('2026-10-14T09:00'), end: kst('2026-10-14T15:00'), created: kst('2026-10-11T18:10'),
    windowStart: kst('2026-10-14T09:00'), windowEnd: kst('2026-10-14T12:00') };
  assert.ok(!R.checkViolations(r, [], cfg).some(v => v.includes('세션 초과')));
  assert.ok(R.checkViolations({ ...r, windowStart: null, windowEnd: null }, [], cfg).some(v => v.includes('세션 초과')));
});
t('날짜를 넘기는 예약 표기', () => {
  assert.strictEqual(R.fmtSlot(kst('2026-10-14T21:00'), kst('2026-10-15T09:00')), '10/14(수) 21:00–10/15(목) 09:00');
  assert.strictEqual(R.fmtSlot(kst('2026-10-15T00:00'), kst('2026-10-15T09:00')), '10/15(목) 00:00–09:00');
});
t('점검: 직전 취소 아님, 하루 제한 제외, 중복 순위 1순위', () => {
  assert.strictEqual(R.classifyBooking(kst('2026-10-12T10:00'), wed15, false, R.KIND.MAINTENANCE), R.KIND.MAINTENANCE);
  assert.strictEqual(R.isLateCancel(R.KIND.MAINTENANCE, kst('2026-10-12T10:00'), wed15, kst('2026-10-14T15:30'), cfg), false);
  const m = { calendarId: 'A', eventId: 'm', booker: '점검', kind: R.KIND.MAINTENANCE, created: kst('2026-10-13T10:00'),
    start: kst('2026-10-14T09:00'), end: kst('2026-10-14T18:00') };
  const p = { calendarId: 'A', eventId: 'p', booker: 'UserA', kind: R.KIND.PRIORITY, created: kst('2026-10-11T18:00'),
    start: kst('2026-10-14T09:00'), end: kst('2026-10-14T12:00') };
  assert.deepStrictEqual(R.conflictGroups([p, m])[0].map(r => r.booker), ['점검', 'UserA']);
  assert.ok(R.checkViolations(p, [m], cfg).some(v => v.indexOf('겹침(점검)') >= 0));
  assert.strictEqual(R.summarizeWeek([Object.assign({ status: '예약' }, m)], kst('2026-10-19T09:00')).length, 0);
});
t('하루 제한 제외 장비', () => {
  const r = { calendarId: 'AFM', bookerKey: 'userg', booker: 'UserG', eventId: 'h', kind: R.KIND.PRIORITY,
    start: kst('2026-10-12T13:00'), end: kst('2026-10-12T18:00'), created: kst('2026-10-11T21:30') };
  assert.ok(R.checkViolations(r, [], cfg).some(v => v.includes('세션 초과')), '제외하지 않으면 2세션 = 초과');
  assert.ok(!R.checkViolations(r, [], { ...cfg, DAY_LIMIT_EXEMPT: ['AFM'] }).some(v => v.includes('세션 초과')), '제외 장비는 표시 없음');
});
console.log(n + ' tests passed');
