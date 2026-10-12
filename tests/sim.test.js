// node tests/sim.test.js — Apps Script 모의 실행으로 동기화·알림·월요일 메일을 시나리오별로 검사
//
// 알림 정책(검사 기준)
//   - 그룹 메일은 두 가지뿐: 이번 주 슬롯의 「직전 취소」(빈 시간만), 월 09:00 브리핑(이번 주 예약 + 지난주 이행률)
//   - 등록·정상 취소·변경·일부 취소·중복 예약: 메일 없음, 기록만(중복 순위는 캘린더 등록 시각 순)
//   - 기간전예약: 예약자 개인 메일
//   - 등록: 메일 없음, 등록 시각(초)을 기록
//   - 정기예약 기간(일 18:00~월 09:00)에 다음 주 슬롯에 생긴 취소·중복: 메일 없음 → 월 09:00 브리핑
//   - 월 09:00 이후(또는 이번 주 남은 슬롯): 취소·변경·일부 취소, 중복 예약은 바로 메일
//   - 월 09:00: 이번 주 브리핑 + 지난주 이행률 보고
//   - 사용 시작 뒤 삭제·이동(겹치지 않는 시간·다른 장비) = 직전 취소, 이름 변경 = 양도(이행률 제외), 겹치는 시간 조정(사용 중 포함) = 같은 예약
//
// 옵션: SIM_VERBOSE=1 이면 통과한 검사도 출력, SIM_ONLY=3,7 이면 해당 시나리오만
'use strict';
const { World, mapStack, kst } = require('./lib/gas-sim');

const CAL = {
  AFM: 'example-afm@group.calendar.google.com',
  SPUT: 'example-sputter@group.calendar.google.com',
  TE1: 'example-thermal-1@group.calendar.google.com',
  TE2: 'example-thermal-2@group.calendar.google.com',
  ME: 'admin@example.com'
};
const NAMES = {
  AFM: '[LAB-A] Atomic Force Microscope',
  SPUT: '[LAB-B] Sputtering system',
  TE1: '[LAB-B] Thermal evaporator',
  TE2: '[LAB-B] Thermal evaporator',   // 같은 이름 두 대 → (2)
  ME: 'admin@example.com'
};
const GROUP = 'equipment-group@example.com';
const ADMIN = 'admin@example.com';
const ADMIN_TO = 'admin@example.com,admin-secondary@example.com'; // 관리자 메일의 받는 사람(관리자 전원)

// ------------------------------------------------------------------ 검사 틀
const VERBOSE = !!process.env.SIM_VERBOSE;
const ONLY = process.env.SIM_ONLY ? process.env.SIM_ONLY.split(',').map(s => s.trim()) : null;
const results = [];
let cur = null;

function scenario(id, title, fn) {
  if (ONLY && ONLY.indexOf(id) < 0) return;
  cur = { id, title, checks: [] };
  try {
    fn();
  } catch (e) {
    cur.checks.push({ pass: false, label: '시나리오 실행 중 예외', detail: mapStack(e.stack || String(e)) });
  }
  results.push(cur);
  const bad = cur.checks.filter(c => !c.pass);
  console.log('\n[' + id + '] ' + title + (bad.length ? '  — 실패 ' + bad.length : '  — 통과 ' + cur.checks.length));
  for (const c of cur.checks) {
    if (c.pass && !VERBOSE) continue;
    console.log('  ' + (c.pass ? 'ok   ' : 'FAIL ') + c.label + (c.detail && !c.pass ? '\n        ' + String(c.detail).replace(/\n/g, '\n        ') : ''));
  }
}
const check = (pass, label, detail) => { cur.checks.push({ pass: !!pass, label, detail }); return !!pass; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const eq = (a, b, label) => check(same(a, b), label, 'got ' + JSON.stringify(a) + ' / want ' + JSON.stringify(b));
const has = (text, part, label) => check(String(text).indexOf(part) >= 0, label, 'missing ' + JSON.stringify(part) + ' in:\n' + String(text).slice(0, 2500));
const hasNot = (text, part, label) => check(String(text).indexOf(part) < 0, label, 'unexpected ' + JSON.stringify(part) + ' in:\n' + String(text).slice(0, 2500));
const fmt = ms => (ms ? new Date(ms + 9 * 3600e3).toISOString().slice(5, 19).replace('T', ' ') : '');
function runOk(exec, label) {
  return check(!exec.error && exec.errors.length === 0, (label || exec.fn) + ' @' + fmt(exec.at) + ' 오류 없음',
    (exec.errorText || '') + exec.errors.join('\n'));
}

// ------------------------------------------------------------------ 세계
function boot(opts = {}) {
  const at = opts.at || '2026-10-11T15:00';
  const w = new World({ now: at, config: opts.config });
  for (const k of Object.keys(CAL)) w.calendar.addCalendar(CAL[k], NAMES[k], Object.assign({ accessRole: k === 'ME' ? 'owner' : 'writer' }, (opts.calOpts || {})[k]));
  if (opts.before) opts.before(w);
  w.at(at);
  w.bootExecs = [w.run('setup'), w.run('fillEquipmentSheet')];
  if (opts.initialSync !== false) w.bootExecs.push(w.run('initialSync'));
  return w;
}
const bootOk = w => w.bootExecs.forEach(e => runOk(e, 'boot ' + e.fn));
const ev = (w, cal, summary, start, end, extra) => w.calendar.create(cal, Object.assign({ summary, start, end }, extra || {}));
const at = (w, t) => { w.at(t); return w; };
const sync = (w, t) => { w.at(t); return w.run('syncAll'); };
const syncOk = (w, t, label) => { const e = sync(w, t); runOk(e, label); return e; };
const isCan = m => /^\[예약취소\] /.test(m.subject);
const isConf = m => /^\[장비예약\] 중복 예약/.test(m.subject);
const isBrief = m => /^\[장비예약\] .+ 예약 내역$/.test(m.subject);
const isRep = isBrief; // 지난주 이행률은 월요일 브리핑에 함께 들어 있다
const lastRow = (w, id) => { const r = w.rowsOf(id); return r[r.length - 1]; };
const text = ms => ms.map(m => m.subject + '\n' + m.body).join('\n=====\n');
const brief = r => r ? [r['예약자'], r['상태'], r['등록구분'], r['직전취소']] : r;

// ================================================================== 1
scenario('1', '설치: 장비 시트(이름 중복 처리·권한), initialSync는 조용히, 설치 주에는 월요일 메일 없음', () => {
  const ids = {};
  const w = boot({
    calOpts: { SPUT: { accessRole: 'reader' } },
    before: w => {
      at(w, '2026-09-15T10:00'); ids.old = ev(w, CAL.TE1, 'UserF(Ag)', '2026-09-20T09:00', '2026-09-20T12:00');
      at(w, '2026-10-04T19:00'); ids.userd = ev(w, CAL.SPUT, 'UserD', '2026-10-06T09:00', '2026-10-06T12:00');
      at(w, '2026-10-09T12:00'); ids.gone = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-09T15:00', '2026-10-09T18:00');
      at(w, '2026-10-09T12:30'); w.calendar.remove(CAL.AFM, ids.gone);
      at(w, '2026-10-10T10:00'); ids.usere = ev(w, CAL.AFM, 'UserE(AFM)', '2026-10-13T09:00', '2026-10-13T12:00');
      at(w, '2026-10-10T11:00'); ids.allday = ev(w, CAL.TE2, 'Example maintenance', '2026-10-16T00:00', '2026-10-17T00:00', { allDay: true });
      at(w, '2026-10-10T12:00'); ids.personal = ev(w, CAL.ME, 'Personal appointment', '2026-10-13T10:00', '2026-10-13T11:00');
    }
  });
  bootOk(w);
  const eqRows = w.table('장비');
  eq(eqRows.map(r => r['사용(Y/N)']), ['Y', 'Y', 'Y', 'Y', 'N'], '[호실] 캘린더 4개 Y, 개인 캘린더 N');
  eq(eqRows.map(r => r['장비명']).slice(2, 4), ['[LAB-B] Thermal evaporator', '[LAB-B] Thermal evaporator (2)'], '같은 이름은 (2)');
  eq(eqRows.map(r => r['권한']).slice(0, 2), ['writer', 'reader'], '권한 열');
  eq(w.mails.length, 0, '설치 동안 메일 0통');
  eq(w.rows().length, 2, '기록 2건(오래된·삭제·종일·개인 캘린더 제외)');
  eq(lastRow(w, ids.userd)['등록구분'], '정기예약', '지난주 정기예약');
  eq(lastRow(w, ids.usere)['등록구분'], '기간전예약', '토요일 등록 = 기간전예약');
  eq(w.props.get('briefingWeek'), String(Date.parse('2026-10-05T09:00+09:00')), '설치 주 브리핑은 보낸 것으로 표시');
  eq(w.props.get('reportWeek'), String(Date.parse('2026-10-05T09:00+09:00')), '설치한 주(일부만 봄)의 보고는 건너뜀');
  check(!w.calendar.calls.some(c => c.calendarId === CAL.ME && c.api === 'events.list'), '사용 N 캘린더는 읽지 않음');
  check(w.calendar.calls.filter(c => c.api === 'events.list' && !c.opts.syncToken && !c.opts.timeMax).every(c => c.opts.timeMin),
    '전체 동기화는 timeMin을 준다');
  syncOk(w, '2026-10-11T15:05');
  w.run('initialSync');
  eq(w.rows().length, 2, '다시 동기화해도 중복 없음');
  eq(w.mails.length, 0, '메일 0통');
});

// ================================================================== 2
function windowWorld() {
  const ids = {};
  const w = boot({
    before: w => {
      at(w, '2026-10-04T19:00'); ids.lastWeek = ev(w, CAL.SPUT, 'UserD', '2026-10-06T09:00', '2026-10-06T12:00');
      at(w, '2026-10-10T10:00'); ids.usereEarly = ev(w, CAL.AFM, 'UserE(AFM)', '2026-10-14T11:00', '2026-10-14T12:00');
    }
  });
  at(w, '2026-10-11T18:00:03'); ids.userb = ev(w, CAL.AFM, 'UserB(Ag)', '2026-10-14T09:00', '2026-10-14T12:00');
  at(w, '2026-10-11T18:00:41'); ids.usera1 = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-14T10:00', '2026-10-14T13:00');
  at(w, '2026-10-11T18:01:10'); ids.usera2 = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-14T15:00', '2026-10-14T18:00');
  at(w, '2026-10-11T18:05'); ids.userd = ev(w, CAL.SPUT, 'UserD', '2026-10-15T09:00', '2026-10-15T12:00');
  return { w, ids };
}
scenario('2', '정기예약 기간: 등록·다음 주 취소·중복은 메일 없음, 이번 주 남은 슬롯 취소는 바로', () => {
  const { w, ids } = windowWorld();
  bootOk(w);
  syncOk(w, '2026-10-11T18:02');
  syncOk(w, '2026-10-11T18:10');
  at(w, '2026-10-11T19:00'); ids.tonight = ev(w, CAL.TE1, 'UserG(Ag)', '2026-10-11T21:00', '2026-10-11T23:00');
  syncOk(w, '2026-10-11T19:05');
  at(w, '2026-10-11T20:00'); w.calendar.remove(CAL.TE1, ids.tonight);
  at(w, '2026-10-11T21:10'); w.calendar.remove(CAL.SPUT, ids.userd);
  const e = syncOk(w, '2026-10-11T21:15');
  eq(w.mails.length, 1, '기간 중 메일은 이번 주(오늘 밤) 슬롯 취소 1통뿐');
  const m = e.mails[0] || {};
  check(isCan(m), '취소 메일', m.subject);
  eq([m.to, m.cc, m.replyTo], [GROUP, undefined, ADMIN], '그룹으로, 참조 없음, 답장=관리자');
  eq(m.subject, '[예약취소] 10/11(일) 21:00–23:00 · [LAB-B] Thermal evaporator', '제목: [예약취소] 시간 · 장비');
  has(m.body.split(String.fromCharCode(10))[0], '[LAB-B] Thermal evaporator 예약이 취소되었습니다.', '첫 줄');
  has(m.body, '시간: 10/11(일) 21:00–23:00', '시간');
  has(m.body, '예약자: UserG', '예약자');
  hasNot(m.body, '빈 시간', '빈 시간 줄 없음');
  hasNot(m.body, '등록', '등록 구분 없음');
  has(m.body, '취소: 10/11(일) 20:00', '취소 시각');
  has(m.htmlBody, '<table', 'HTML 카드');
  has(m.htmlBody, '<b>[LAB-B] Thermal evaporator</b> 예약이 취소되었습니다.', '첫 줄 장비 이름 굵게');
  has(m.htmlBody, '<b>UserG</b>', '예약자 이름 굵게');
  eq(brief(lastRow(w, ids.userd)), ['UserD', '취소', '정기예약', 'N'], '월 09:00 전 정기예약 취소 = 정상');
  eq(lastRow(w, ids.userb)['등록시각'], Date.parse('2026-10-11T18:00:03+09:00'), '등록 시각을 초 단위로 기록');
  has(lastRow(w, ids.usera2)['위반'], '하루 1세션 초과', 'UserA 같은 날 두 번 = 하루 제한 위반');
  syncOk(w, '2026-10-12T08:55');
  eq(w.mails.length, 1, '월 08:55까지 추가 메일 없음');
});

// ================================================================== 3
scenario('3', '월 09:00: 이번 주 브리핑(중복 우선순위·규칙 확인·기간 중 취소·예약표) + 지난주 보고, 한 번만', () => {
  const { w, ids } = windowWorld();
  bootOk(w);
  syncOk(w, '2026-10-11T18:02');
  at(w, '2026-10-11T21:10'); w.calendar.remove(CAL.SPUT, ids.userd);
  syncOk(w, '2026-10-12T08:55');
  const e = syncOk(w, '2026-10-12T09:00:20');
  const b = e.mails.find(isBrief);
  check(b && e.mails.length === 1, '브리핑 1통(설치한 주의 보고는 건너뜀)', text(e.mails));
  if (!b) return;
  eq(b.to, GROUP, '브리핑은 그룹으로');
  eq(b.subject, '[장비예약] 10/12(월)~10/19(월) 예약 내역', '제목(휴대폰 한 줄: 날짜만)');
  has(b.body, '1순위 UserE', '순위는 캘린더 등록 순만(10/10 등록이 1순위)');
  has(b.body, '2순위 UserB', '2순위 = 18:00:03');
  has(b.body, '3순위 UserA', '3순위 = 18:00:41');
  has(b.body, '[등록 10/11(일) 18:00:03]', '등록 시각 초 단위 표기');
  check(/  ·  \d\d\/\d\d\(.\) \d\d:\d\d–\d\d:\d\d.* 겹침/.test(b.body), '묶음 제목 줄에 겹치는 시간', b.body);
  check(b.htmlBody.indexOf('background:#ef4444') > 0 && b.htmlBody.indexOf('color:#b3261e;font-size:13px') > 0, 'HTML: 겹치는 부분 빨간 막대·빨간 겹침 시간', b.htmlBody);
  has(b.body, '하루 1세션 초과', '규칙 확인: 하루 제한');
  has(b.body, '[기간전예약]', '규칙 확인: 기간전');
  check(/<b>[^<]+<\/b>&nbsp; [^<]+<\/td><td align="right" valign="top" style="[^"]*color:#b3261e;font-size:13px">하루 1세션 초과<\/td>/.test(b.htmlBody),
    'HTML: 어긴 규칙은 같은 줄 오른쪽 끝(빨강)', b.htmlBody);
  hasNot(b.body, 'UserD', '취소된 예약은 나오지 않음');
  has(b.body, '▶ [LAB-A] Atomic Force Microscope (4건)', '장비별 예약표');
  has(b.body.split(String.fromCharCode(10))[0], '10/12(월) 09:00 ~ 10/19(월) 09:00 예약 내역', '첫 줄');
  has(b.body, '■ 중복 예약 1건' + String.fromCharCode(10), '중복 예약 머리줄은 건수만');
  check(b.htmlBody.indexOf('border-radius:8px') > 0 && b.htmlBody.indexOf('예약기록 시트 열기</a>') > 0, 'HTML 카드와 시트 링크', b.htmlBody);
  const e2 = syncOk(w, '2026-10-12T09:05');
  eq(e2.mails.length, 0, '다음 동기화에서 다시 보내지 않음');
  eq(w.table('주간보고').length, 0, '설치한 주는 주간보고 시트에도 없음');
});

// ================================================================== 4
scenario('4', '월 09:00 이후 취소는 바로: 정기예약 직전 취소, 추가예약 당일 기준(24~09 포함), 유예', () => {
  const ids = {};
  const w = boot();
  bootOk(w);
  at(w, '2026-10-11T19:00'); ids.userb = ev(w, CAL.AFM, 'UserB(Ag)', '2026-10-13T09:00', '2026-10-13T12:00');
  at(w, '2026-10-11T19:10'); ids.usera = ev(w, CAL.SPUT, 'UserA (BCP)', '2026-10-14T12:00', '2026-10-14T15:00');
  syncOk(w, '2026-10-11T19:15');
  at(w, '2026-10-12T08:30'); w.calendar.remove(CAL.AFM, ids.userb);
  syncOk(w, '2026-10-12T08:35');
  eq(w.mails.length, 0, '월 08:30 취소(다음 주 슬롯)는 바로 보내지 않음');
  syncOk(w, '2026-10-12T09:00:20');
  w.mails.length = 0;
  at(w, '2026-10-12T10:00'); w.calendar.remove(CAL.SPUT, ids.usera);
  ids.userd = ev(w, CAL.TE1, 'UserD', '2026-10-14T15:00', '2026-10-14T18:00');
  at(w, '2026-10-12T11:00'); ids.userf = ev(w, CAL.TE1, 'UserF(Ag)', '2026-10-15T00:00', '2026-10-15T09:00');
  let e = syncOk(w, '2026-10-12T11:05');
  eq(e.mails.length, 1, '직전 취소 1건 → 메일 1통(등록 2건은 메일 없음)');
  has(e.mails[0] && e.mails[0].body, '시간: 10/14(수) 12:00–15:00', '월 10:00 정기예약 취소 = 직전 취소');
  has(e.mails[0] && e.mails[0].body, '예약자: UserA', '예약자');
  has(e.mails[0] && e.mails[0].body, '취소: 10/12(월) 10:00', '취소 시각');
  hasNot(e.mails[0] && e.mails[0].body, '빈 시간', '빈 시간 줄 없음');
  eq(brief(lastRow(w, ids.userb)), ['UserB', '취소', '정기예약', 'N'], '월 08:30 취소 = 정상');
  at(w, '2026-10-13T23:00'); w.calendar.remove(CAL.TE1, ids.userd);
  e = syncOk(w, '2026-10-13T23:05');
  eq(e.mails.length, 0, '추가예약 전날 취소 = 정상: 메일 없음');
  at(w, '2026-10-14T09:30'); w.calendar.remove(CAL.TE1, ids.userf);
  e = syncOk(w, '2026-10-14T09:35');
  has(e.mails[0] && e.mails[0].body, '시간: 10/15(목) 00:00–09:00', '수 24~09 세션을 수 09:30에 취소 = 당일 = 직전 취소');
  at(w, '2026-10-15T10:00'); ids.dm = ev(w, CAL.SPUT, 'UserI', '2026-10-15T15:00', '2026-10-15T18:00');
  syncOk(w, '2026-10-15T10:02');
  at(w, '2026-10-15T10:06'); w.calendar.remove(CAL.SPUT, ids.dm);
  e = syncOk(w, '2026-10-15T10:08');
  eq(e.mails.length, 0, '등록 후 10분 안에 지움: 메일 없음');
  eq(lastRow(w, ids.dm)['직전취소'], 'N', '유예 = 정상');
});

// ================================================================== 5
scenario('5', '중복 예약·정상 변경은 메일 없음, 기록만', () => {
  const ids = {};
  const w = boot({ at: '2026-10-12T09:30' });
  bootOk(w);
  at(w, '2026-10-12T10:00:05'); ids.j = ev(w, CAL.AFM, 'UserB(Ag)', '2026-10-16T09:00', '2026-10-16T12:00');
  at(w, '2026-10-12T10:00:45'); ids.d = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-16T10:00', '2026-10-16T13:00');
  ids.solo = ev(w, CAL.SPUT, 'UserD', '2026-10-16T09:00', '2026-10-16T12:00');
  let e = syncOk(w, '2026-10-12T10:05');
  eq(e.mails.length, 0, '중복 예약도 메일 없음(월요일 브리핑에서 본다)');
  e = syncOk(w, '2026-10-12T10:10');
  eq(e.mails.length, 0, '메일 없음');
  at(w, '2026-10-12T10:30'); w.calendar.patch(CAL.AFM, ids.d, { start: '2026-10-16T13:00', end: '2026-10-16T16:00' });
  e = syncOk(w, '2026-10-12T10:35');
  eq(e.mails.length, 0, '정상 변경: 메일 없음');
  eq(w.rowsOf(ids.d).map(r => r['상태']), ['변경', '예약'], '원래 시간 「변경」 + 새 예약');
  eq(w.rowsOf(ids.d)[0]['직전취소'], 'N', '전날 이전 이동 = 정상');
});

// ================================================================== 6
scenario('6', '사용 시작 뒤 삭제 = 직전 취소, 사용 중 단축·시작 전 연장 = 같은 예약, 시작 전 단축 = 일부 취소 알림', () => {
  const ids = {};
  const w = boot();
  bootOk(w);
  at(w, '2026-10-12T10:00');
  ids.dm = ev(w, CAL.SPUT, 'UserI', '2026-10-13T09:00', '2026-10-13T12:00');
  ids.userf = ev(w, CAL.TE1, 'UserF(Ag)', '2026-10-14T09:00', '2026-10-14T12:00');
  ids.userd = ev(w, CAL.AFM, 'UserD', '2026-10-15T09:00', '2026-10-15T12:00');
  ids.usere = ev(w, CAL.AFM, 'UserE(AFM)', '2026-10-16T09:00', '2026-10-16T15:00');
  syncOk(w, '2026-10-12T10:05');
  at(w, '2026-10-13T13:00'); w.calendar.remove(CAL.SPUT, ids.dm);
  at(w, '2026-10-14T11:05'); w.calendar.patch(CAL.TE1, ids.userf, { end: '2026-10-14T11:00' });
  at(w, '2026-10-14T20:00'); w.calendar.patch(CAL.AFM, ids.userd, { end: '2026-10-15T15:00' });
  let e = syncOk(w, '2026-10-14T20:05');
  eq(e.mails.length, 0, '사용 뒤 삭제·사용 중 단축·연장: 메일 없음');
  eq(w.rowsOf(ids.dm).map(r => [r['상태'], r['직전취소']]), [['취소', 'Y']], '사용 시작 뒤 삭제 = 직전 취소');
  eq(w.rowsOf(ids.userf).map(r => r['상태']), ['예약'], '사용 중 단축 → 같은 예약');
  eq(w.rowsOf(ids.userd).length, 1, '연장 → 같은 예약 한 행');
  at(w, '2026-10-15T20:00'); w.calendar.patch(CAL.AFM, ids.usere, { end: '2026-10-16T12:00' });
  e = syncOk(w, '2026-10-15T20:05');
  eq(e.mails.length, 0, '시작 전 단축: 메일 없음');
  eq(w.rowsOf(ids.usere).map(r => r['상태']), ['예약'], '단축해도 같은 예약(직전 취소로 세지 않음)');
  const r = syncOk(w, '2026-10-19T09:00:20').mails.find(isRep);
  has(r && r.body, 'UserI  직전 취소 1건 · 사용 0건   [4주간 직전 취소 1건]', 'UserI 직전 취소');
  hasNot(r && r.body, 'UserF  직전 취소', '직전 취소 없는 사람은 나오지 않음');
});

// ================================================================== 7
scenario('7', '이름 변경 = 양도(메일 없음, 이행률 제외), 제목 수정은 조용히, 장비 캘린더 이동 = 변경 메일 한 통', () => {
  const ids = {};
  const w = boot();
  bootOk(w);
  at(w, '2026-10-12T10:00');
  ids.d = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-14T09:00', '2026-10-14T12:00');
  ids.h = ev(w, CAL.TE1, 'UserG(Ag)', '2026-10-15T15:00', '2026-10-15T18:00');
  syncOk(w, '2026-10-12T10:05');
  at(w, '2026-10-13T10:00'); w.calendar.patch(CAL.AFM, ids.d, { summary: 'UserB(Ag)' });
  let e = syncOk(w, '2026-10-13T10:05');
  eq(e.mails.length, 0, '양도는 메일 없음');
  eq(w.rowsOf(ids.d).map(brief), [['UserA', '양도', '추가예약', ''], ['UserB', '예약', '추가예약', '']], '양도 + 새 예약');
  at(w, '2026-10-13T10:20'); w.calendar.patch(CAL.AFM, ids.d, { summary: 'userb (Ag) ' });
  e = syncOk(w, '2026-10-13T10:25');
  eq([e.mails.length, w.rowsOf(ids.d).length], [0, 2], '같은 이름 제목 수정은 조용히');
  at(w, '2026-10-13T11:00'); w.calendar.move(CAL.TE1, ids.h, CAL.TE2);
  e = syncOk(w, '2026-10-13T11:05');
  eq(e.mails.length, 0, '장비 이동(정상): 메일 없음');
  const te1 = w.rowsOf(ids.h).find(r => r['캘린더ID'] === CAL.TE1);
  const te2 = w.rowsOf(ids.h).find(r => r['캘린더ID'] === CAL.TE2);
  eq(te1 && te1['상태'], '변경', '원래 장비 기록 = 변경');
  eq(te2 && [te2['상태'], fmt(te2['등록시각'])], ['예약', '10-13 11:00:00'], '새 장비 기록: 등록 = 이동 시각');
  const r = syncOk(w, '2026-10-19T09:00:20').mails.find(isRep);
  has(r && r.body, '(직전 취소 0건 · ', '양도는 직전 취소가 아님');
  has(r && r.body, '직전 취소 없음', '직전 취소 없음');
});

// ================================================================== 8
scenario('8', '지운 일정에 updated가 없을 때: Events.get, 그다음 지난 동기화 시각(유리한 쪽)', () => {
  for (const mode of ['minimal', 'full']) {
    const ids = {};
    const w = boot({ calOpts: { AFM: { deletedForm: 'minimal', getDeleted: mode } } });
    bootOk(w);
    at(w, '2026-10-11T19:20'); ids.j = ev(w, CAL.AFM, 'UserB(Ag)', '2026-10-13T09:00', '2026-10-13T12:00');
    syncOk(w, '2026-10-12T08:55');
    at(w, '2026-10-12T08:58'); w.calendar.remove(CAL.AFM, ids.j);
    syncOk(w, '2026-10-12T09:00:20');
    const row = lastRow(w, ids.j);
    eq([row['상태'], row['직전취소'], fmt(row['취소시각'])], ['취소', 'N', mode === 'full' ? '10-12 08:58:00' : '10-12 08:55:00'],
      'Mon 08:58 삭제(응답에 updated 없음, get=' + mode + ') = 정상 취소');
  }
  const ids = {};
  const w = boot({ at: '2026-10-16T09:30', calOpts: { SPUT: { deletedForm: 'minimal' } } });
  at(w, '2026-10-16T10:00'); ids.l = ev(w, CAL.SPUT, 'UserD', '2026-10-16T15:00', '2026-10-16T18:00');
  syncOk(w, '2026-10-16T10:02');
  at(w, '2026-10-16T10:07'); w.calendar.remove(CAL.SPUT, ids.l);
  syncOk(w, '2026-10-16T10:12');
  eq(lastRow(w, ids.l)['직전취소'], 'N', '등록 7분 뒤 삭제(10:12 발견) = 유예');
});

// ================================================================== 9
scenario('9', '동기화 토큰 만료(410): 사이에 생긴 취소도 알림, 목록에서 사라진 일정도 닫음, 중복 없음', () => {
  for (const purge of [false, true]) {
    const ids = {};
    const w = boot({ at: '2026-10-12T09:30', calOpts: { AFM: { purgeDeletedOnFullList: purge } } });
    at(w, '2026-10-12T10:00'); ids.d = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-12T15:00', '2026-10-12T18:00');
    ids.j = ev(w, CAL.AFM, 'UserB(Ag)', '2026-10-16T09:00', '2026-10-16T12:00');
    syncOk(w, '2026-10-12T10:05');
    w.calendar.invalidateTokens(CAL.AFM);
    at(w, '2026-10-12T12:30'); w.calendar.remove(CAL.AFM, ids.d);
    const e = syncOk(w, '2026-10-12T12:35');
    // purge: 지운 시각을 몰라 직전 동기화 시각(등록 5분 뒤)으로 보므로 유예 → 직전 취소 아님, 메일 없음
    eq(e.mails.filter(isCan).length, purge ? 0 : 1, '만료 사이 직전 취소 메일 (purge=' + purge + ')');
    eq(w.rowsOf(ids.d).map(r => r['상태']), ['취소'], '취소 기록 (purge=' + purge + ')');
    eq(w.rowsOf(ids.j).length, 1, '바뀌지 않은 일정은 중복 기록 없음');
  }
});

// ================================================================== 10
scenario('10', '메일 실패: 알림이 남아 다음 실행에서 한 번 보냄, 월요일 메일도 다시 시도', () => {
  const ids = {};
  const w = boot();
  at(w, '2026-10-12T10:00'); ids.d = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-13T15:00', '2026-10-13T18:00');
  syncOk(w, '2026-10-12T10:05');
  at(w, '2026-10-13T10:00'); w.calendar.remove(CAL.AFM, ids.d);
  w.mailFail = 'Service invoked too many times for one day: email.';
  let e = sync(w, '2026-10-13T10:05');
  eq(e.mails.length, 0, '실패한 실행: 보낸 메일 없음');
  w.mailFail = null;
  e = syncOk(w, '2026-10-13T10:10');
  eq(e.mails.filter(isCan).length, 1, '다음 실행에서 취소 메일');
  e = syncOk(w, '2026-10-13T10:15');
  eq(e.mails.length, 0, '다시 보내지 않음');
  w.mailFail = 'temporary';
  sync(w, '2026-10-19T09:00:20');
  w.mailFail = null;
  e = syncOk(w, '2026-10-19T09:05');
  eq([e.mails.filter(isBrief).length, e.mails.filter(isRep).length], [1, 1], '월요일 메일 실패 → 다음 실행에서 보냄');
  eq(w.table('주간보고').length, 1, '주간보고 시트는 한 번만');
});

// ================================================================== 11
scenario('11', '반복 일정: 등록 시각으로 구분(미리 만든 회차는 기간전예약), 먼 회차는 하루 한 번 채움, 시리즈 삭제 시 지난 회차는 이행', () => {
  const w = boot({
    before: w => {
      at(w, '2026-09-30T10:00');
      const starts = [];
      for (let d = Date.parse('2026-10-08T13:00+09:00'); d <= Date.parse('2026-12-31T13:00+09:00'); d += 7 * 86400e3) starts.push(d);
      w.series = w.calendar.createRecurring(CAL.AFM, { summary: 'UserG(Ag) weekly', start: '2026-10-08T13:00', end: '2026-10-08T15:00' }, starts);
    }
  });
  bootOk(w);
  const rows = () => w.rows().filter(r => r['예약자'] === 'UserG');
  eq(rows().length, 5, '기록은 오늘+28일 안의 회차만(10/08~11/05)');
  eq(Array.from(new Set(rows().map(r => r['등록구분']))), ['기간전예약'], '9/30에 만든 반복 일정 = 기간전예약');
  eq(rows().filter(r => r['위반'].indexOf('기간전예약') >= 0).length, 5, '위반 표시');
  syncOk(w, '2026-10-16T08:00');
  eq(rows().length, 6, '다음 날 동기화에서 새로 기간에 든 회차를 채움(11/12)');
  eq(w.mails.filter(m => !isBrief(m) && !isRep(m)).length, 0, '채울 때 메일 없음(월요일 메일만)');
  w.at('2026-10-22T14:00');
  w.series.forEach(id => { try { w.calendar.remove(CAL.AFM, id); } catch (e) { /* */ } });
  const e = syncOk(w, '2026-10-22T14:05');
  const past = rows().filter(r => Date.parse(new Date(r['시작']).toISOString()) <= Date.parse('2026-10-22T13:00+09:00'));
  const ended = past.filter(r => r['종료'] <= Date.parse('2026-10-22T14:00+09:00') && fmt(r['시작']) !== '10-22 13:00:00');
  eq(Array.from(new Set(ended.map(r => r['상태']))), ['예약'], '이미 끝난 회차가 시리즈째 지워진 것은 이행 유지');
  eq(rows().filter(r => r['직전취소'] === 'Y').map(r => fmt(r['시작'])), ['10-22 13:00:00'], '진행 중 회차만 직전 취소(사용 시작 뒤), 다음 주 이후는 정상');
  eq(e.mails.filter(isCan).length, 1, '앞으로의 회차 취소는 메일 한 통');
});

// ================================================================== 12
scenario('12', '별칭을 나중에 추가해도 이름 변경이 아님, 비공개(제목 없음) 일정, 지우고 다시 만들기', () => {
  const ids = {};
  const w = boot({ at: '2026-10-12T09:30' });
  at(w, '2026-10-12T10:00'); ids.d = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-15T09:00', '2026-10-15T12:00');
  ids.p = ev(w, CAL.SPUT, undefined, '2026-10-15T09:00', '2026-10-15T12:00', { creator: 'userg@example.com' });
  syncOk(w, '2026-10-12T10:05');
  w.sheet('사용자').appendRow(['가나다', 'UserA, 나다']);
  at(w, '2026-10-13T10:58'); w.calendar.patch(CAL.AFM, ids.d, {});
  w.calendar.patch(CAL.SPUT, ids.p, {});
  let e = syncOk(w, '2026-10-13T11:00');
  eq(e.mails.length, 0, '메일 없음');
  eq(w.rowsOf(ids.d).map(brief), [['가나다', '예약', '추가예약', '']], '별칭 추가 후 수정: 같은 예약, 대표 이름으로');
  eq(w.rowsOf(ids.p).map(r => r['예약자']), ['(제목 없음 userg@example.com)'], '제목 없는 일정: 만든 계정으로 구분');
  at(w, '2026-10-13T12:00'); ids.j1 = ev(w, CAL.TE1, 'UserF(Ag)', '2026-10-16T09:00', '2026-10-16T12:00');
  syncOk(w, '2026-10-13T12:01');
  at(w, '2026-10-13T12:02'); w.calendar.remove(CAL.TE1, ids.j1);
  at(w, '2026-10-13T12:03'); ids.j2 = ev(w, CAL.TE1, 'UserF(Ag)', '2026-10-16T09:00', '2026-10-16T12:00');
  e = syncOk(w, '2026-10-13T12:05');
  eq(lastRow(w, ids.j2)['위반'], '', '같은 실행에서 지우고 다시 만들면 겹침·초과 표시 없음');
  eq(e.mails.filter(isConf).length, 0, '중복 메일 없음');
});

// ================================================================== 13
scenario('13', '숫자처럼 보이는 ID·제목, 종일 일정으로 바꾸면 취소, 오류 캘린더 알림·브리핑 대기', () => {
  const w = boot({ at: '2026-10-12T09:30' });
  at(w, '2026-10-12T10:00');
  const num = w.calendar.create(CAL.AFM, { id: '20261015', summary: '2024', start: '2026-10-15T09:00', end: '2026-10-15T12:00' });
  const ad = ev(w, CAL.SPUT, 'UserD', '2026-10-15T09:00', '2026-10-15T12:00');
  syncOk(w, '2026-10-12T10:05');
  const row = lastRow(w, num);
  eq(row && [typeof row['일정ID'], typeof row['예약자']], ['string', 'string'], 'ID·이름은 글자로 저장');
  at(w, '2026-10-12T11:00'); w.calendar.remove(CAL.AFM, num);
  w.calendar.patch(CAL.SPUT, ad, { allDay: true });
  let e = syncOk(w, '2026-10-12T11:05');
  eq([lastRow(w, num)['상태'], lastRow(w, ad)['상태']], ['취소', '취소'], '숫자 ID 일정 취소 찾음, 종일로 바꾼 예약 = 취소');
  eq(e.mails.length, 0, '정상 취소 두 건: 메일 없음');
  w.calendar.cal(CAL.TE1).failWith = 'API call to calendar.events.list failed with error: Forbidden';
  e = sync(w, '2026-10-12T11:10');
  eq(e.mails.filter(m => m.to === ADMIN_TO && /동기화 오류/.test(m.subject)).length, 1, '관리자에게 오류 메일');
  e = sync(w, '2026-10-12T11:15');
  eq(e.mails.length, 0, '같은 오류는 하루 한 번만');
  e = sync(w, '2026-10-19T09:00:20');
  eq(e.mails.filter(isBrief).length, 0, '오류가 있으면 월 09:00 브리핑을 잠시 미룸');
  e = sync(w, '2026-10-19T09:31');
  eq(e.mails.filter(isBrief).length, 1, '30분이 지나면 보냄');
});

// ================================================================== 14
scenario('14', '주간 보고 계산, 미리보기는 관리자에게만, 트리거 설치', () => {
  const ids = {};
  const w = boot();
  w.triggers.push({ handler: 'weeklyReport', id: 'old1', type: 'CLOCK', source: 'CLOCK' });
  at(w, '2026-10-11T18:10'); ids.a = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-13T09:00', '2026-10-13T12:00');
  ids.b = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-14T09:00', '2026-10-14T12:00');
  ids.c = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-15T09:00', '2026-10-15T12:00');
  syncOk(w, '2026-10-11T18:15');
  at(w, '2026-10-12T12:00'); w.calendar.remove(CAL.AFM, ids.c);
  syncOk(w, '2026-10-12T12:05');
  w.at('2026-10-16T12:00'); const p = w.run('previewMondayMails'); runOk(p);
  check(p.mails.length === 1 && p.mails.every(m => m.to === ADMIN_TO), '미리보기 1통, 관리자에게만', text(p.mails));
  has(p.mails[0] && p.mails[0].subject, '[미리보기] [장비예약] 10/19(월)~10/26(월) 예약 내역', '이번 주 브리핑을 보낸 뒤면 다음 월요일 것을 미리 봄');
  has(p.mails[0] && p.mails[0].body, 'UserA  직전 취소 1건', '미리보기에 이번 주(다음 월요일의 지난주) 직전 취소');
  const e = syncOk(w, '2026-10-19T09:00:20');
  const r = e.mails.find(isRep);
  has(r && r.body, 'UserA  직전 취소 1건 · 사용 2건   [4주간 직전 취소 1건]', '지난주 직전 취소·사용, 4주간 직전 취소');
  hasNot(r && (r.body + r.htmlBody), '이행률', '브리핑에 이행률 없음');
  has(r && r.body, '10/15(목) 09:00–12:00 [LAB-A] Atomic Force Microscope   [취소 10/12(월) 12:00]', '언제 취소했는지');
  has(r && r.body, '■ 지난주 직전 취소  (직전 취소 1건 · 사용 2건)', '지난주 합계');
  has(r && r.htmlBody, 'white-space:nowrap">직전 취소 1건 · 사용 2건</td>', 'HTML: 합계는 제목 줄 오른쪽');
  const wk = w.table('주간보고');
  eq(wk.map(x => [x['예약자'], x['사용'], x['직전취소']]), [['UserA', 2, 1]], '주간보고 시트');
  w.run('installTriggers');
  eq(w.triggers.map(t => [t.handler, t.everyMinutes]), [['syncAll', 5]], '트리거: 5분 동기화 하나(옛 주간 트리거 삭제)');
});

// ================================================================== 15
scenario('15', '중복 후순위가 지우거나 옮기면 직전 취소 아님(양보), 메일 없음', () => {
  const ids = {};
  const w = boot();
  at(w, '2026-10-11T18:00:03'); ids.j = ev(w, CAL.AFM, 'UserB(Ag)', '2026-10-14T09:00', '2026-10-14T12:00');
  at(w, '2026-10-11T18:00:41'); ids.d = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-14T10:00', '2026-10-14T13:00');
  at(w, '2026-10-11T18:01'); ids.m = ev(w, CAL.SPUT, 'UserE(AFM)', '2026-10-15T09:00', '2026-10-15T12:00');
  at(w, '2026-10-11T18:02'); ids.l = ev(w, CAL.SPUT, 'UserD', '2026-10-15T09:00', '2026-10-15T12:00');
  syncOk(w, '2026-10-11T18:05');
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-12T09:30'); w.calendar.remove(CAL.AFM, ids.d);
  w.calendar.patch(CAL.SPUT, ids.l, { start: '2026-10-15T13:00', end: '2026-10-15T16:00' });
  const e = syncOk(w, '2026-10-12T09:35');
  eq([lastRow(w, ids.d)['직전취소'], lastRow(w, ids.d)['제외사유']], ['N', '양보'], '후순위 삭제 = 직전 취소 아님(양보)');
  eq(w.rowsOf(ids.l).map(r => [r['상태'], r['직전취소']]), [['변경', 'N'], ['예약', '']], '후순위 이동 = 직전 취소 아님');
  eq(e.mails.length, 0, '메일 없음');
});

// ================================================================== 16
scenario('16', '양도는 원래 등록 시각·구분을 이어받음: 중복 메일 다시 안 나감, 기간전 표시 유지', () => {
  const ids = {};
  const w = boot({ before: w => { at(w, '2026-10-10T10:00'); w.early = ev(w, CAL.TE1, 'UserE(AFM)', '2026-10-15T09:00', '2026-10-15T12:00'); } });
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-12T10:00:05'); ids.j = ev(w, CAL.AFM, 'UserB(Ag)', '2026-10-16T09:00', '2026-10-16T12:00');
  at(w, '2026-10-12T10:00:45'); ids.d = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-16T10:00', '2026-10-16T13:00');
  eq(syncOk(w, '2026-10-12T10:05').mails.length, 0, '중복도 메일 없음');
  at(w, '2026-10-12T11:00'); w.calendar.patch(CAL.AFM, ids.j, { summary: 'UserE(AFM)' });
  w.calendar.patch(CAL.TE1, w.early, { summary: 'UserG(Ag)' });
  const e = syncOk(w, '2026-10-12T11:05');
  eq(e.mails.length, 0, '양도는 메일 없음(중복을 다시 알리지 않음)');
  const nj = lastRow(w, ids.j);
  eq([nj['예약자'], fmt(nj['등록시각']), nj['등록구분']], ['UserE', '10-12 10:00:05', '추가예약'], '양도받은 예약 = 원래 등록 시각');
  const ne = lastRow(w, w.early);
  eq([ne['예약자'], ne['등록구분']], ['UserG', '기간전예약'], '기간전예약은 양도해도 기간전예약');
});

// ================================================================== 17
scenario('17', '중복 순위는 캘린더 등록 순만(늘려서 겹쳐도 먼저 등록한 사람이 1순위), 메일 없음', () => {
  const ids = {};
  const w = boot();
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-12T10:00'); ids.j = ev(w, CAL.AFM, 'UserB(Ag)', '2026-10-14T09:00', '2026-10-14T12:00');
  at(w, '2026-10-12T10:30'); ids.d = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-14T12:00', '2026-10-14T15:00');
  eq(syncOk(w, '2026-10-12T10:35').mails.length, 0, '겹침 없음');
  at(w, '2026-10-13T10:00'); w.calendar.patch(CAL.AFM, ids.j, { end: '2026-10-14T15:00' });
  let e = syncOk(w, '2026-10-13T10:05');
  eq(e.mails.length, 0, '메일 없음');
  eq(w.eval('JSON.stringify(conflictGroups(Store.active()).map(g => g.map(r => r.booker)))'), '[["UserB","UserA"]]',
    '먼저 등록한 UserB가 1순위');
  at(w, '2026-10-13T10:30'); w.calendar.patch(CAL.AFM, ids.j, { end: '2026-10-14T14:00' });
  e = syncOk(w, '2026-10-13T10:35');
  eq(e.mails.length, 0, '시간 조정도 메일 없음');
});

// ================================================================== 18
scenario('18', '사용 시작 뒤 다른 날로 옮김: 원래 시간은 「변경」(직전 취소, 남은 시간 알림), 새 시간은 옮긴 시각의 새 예약', () => {
  const ids = {};
  const w = boot();
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-12T10:00'); ids.j = ev(w, CAL.TE1, 'UserF(Ag)', '2026-10-14T09:00', '2026-10-14T12:00');
  syncOk(w, '2026-10-12T10:05');
  at(w, '2026-10-14T10:00'); w.calendar.patch(CAL.TE1, ids.j, { start: '2026-10-16T09:00', end: '2026-10-16T12:00' });
  const e = syncOk(w, '2026-10-14T10:05');
  const m = e.mails.find(isCan) || {};
  has(m.body, '시간: 10/14(수) 09:00–12:00', '원래 예약 시간');
  has(m.body, '취소: 10/14(수) 10:00', '사용 시작 뒤 옮김도 직전 취소로 알림');
  const rows = () => w.rows().filter(r => String(r['일정ID']).indexOf(ids.j) === 0);
  eq(rows().map(r => [r['상태'], r['직전취소'], fmt(r['시작']), fmt(r['등록시각'])]),
    [['변경', 'Y', '10-14 09:00:00', '10-12 10:00:00'], ['예약', '', '10-16 09:00:00', '10-14 10:00:00']], '원래 시간 직전 취소 + 새 예약');
  at(w, '2026-10-15T10:00'); w.calendar.remove(CAL.TE1, ids.j);
  syncOk(w, '2026-10-15T10:05');
  eq(rows().map(r => r['상태']), ['변경', '취소'], '뒤에 지우면 새 예약만 취소');
});

// ================================================================== 19
scenario('19', '월 09:00 브리핑은 캘린더 오류가 있으면 30분까지 기다림, 기간 중 정상 취소는 메일 없음', () => {
  const ids = {};
  const w = boot();
  at(w, '2026-10-11T18:10'); ids.l = ev(w, CAL.AFM, 'UserD', '2026-10-15T09:00', '2026-10-15T12:00');
  syncOk(w, '2026-10-11T18:15');
  w.calendar.cal(CAL.AFM).failWith = 'API call to calendar.events.list failed with error: Backend Error';
  sync(w, '2026-10-12T08:50');
  at(w, '2026-10-12T08:58'); w.calendar.remove(CAL.AFM, ids.l);
  let e = sync(w, '2026-10-12T09:00:20');
  eq(e.mails.filter(isBrief).length, 0, '오류가 있으면 브리핑 대기');
  e = sync(w, '2026-10-12T09:31');
  eq(e.mails.filter(isBrief).length, 1, '30분 뒤 브리핑');
  w.calendar.cal(CAL.AFM).failWith = null;
  e = syncOk(w, '2026-10-12T09:40');
  eq(e.mails.filter(isCan).length, 0, '월 08:58 취소(정상)는 복구 뒤에도 메일 없음');
  eq(lastRow(w, ids.l)['직전취소'], 'N', '월 08:58 취소 = 정상');
});

// ================================================================== 20
scenario('20', '같은 실행에서 지우고 같은 시간으로 다시 만들기·반복 일정 나누기 = 같은 예약', () => {
  const ids = {};
  const w = boot({
    before: w => {
      at(w, '2026-09-30T10:00');
      w.series = w.calendar.createRecurring(CAL.SPUT, { summary: 'UserC for class', start: '2026-10-15T13:00', end: '2026-10-15T15:00' },
        ['2026-10-15T13:00', '2026-10-22T13:00', '2026-10-29T13:00']);
    }
  });
  at(w, '2026-10-11T18:10'); ids.d = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-13T09:00', '2026-10-13T12:00');
  syncOk(w, '2026-10-11T18:15');
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-12T10:00'); w.calendar.remove(CAL.AFM, ids.d);
  at(w, '2026-10-12T10:01'); ids.d2 = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-13T09:00', '2026-10-13T12:00');
  // 'this and following': 옛 회차는 지워지고 새 시리즈(새 ID)가 같은 시간에 생김
  at(w, '2026-10-12T10:02');
  w.series.forEach(id => w.calendar.remove(CAL.SPUT, id));
  w.calendar.createRecurring(CAL.SPUT, { id: 'newseries_R20261015', summary: 'UserC for class', start: '2026-10-15T13:00', end: '2026-10-15T15:00' },
    ['2026-10-15T13:00', '2026-10-22T13:00', '2026-10-29T13:00']);
  const e = syncOk(w, '2026-10-12T10:05');
  eq(e.mails.length, 0, '메일 없음');
  const d = w.rows().find(r => r['예약자'] === 'UserA');
  eq([d['상태'], d['등록구분'], fmt(d['등록시각']), d['일정ID']], ['예약', '정기예약', '10-11 18:10:00', ids.d2], '원래 등록 시각을 이어 감');
  const cls = w.rows().filter(r => r['예약자'] === 'UserC (수업)');
  eq([cls.length, cls.filter(r => r['상태'] === '예약').length], [3, 3], '수업 회차 3건 그대로 예약');
});

// ================================================================== 21
scenario('21', '월 09:00 뒤 빈 시간으로 늘린 정기예약은 하루 제한 위반이 아님', () => {
  const ids = {};
  const w = boot();
  at(w, '2026-10-11T18:10'); ids.d = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-14T09:00', '2026-10-14T12:00');
  syncOk(w, '2026-10-11T18:15');
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-13T10:00'); w.calendar.patch(CAL.AFM, ids.d, { end: '2026-10-14T15:00' });
  syncOk(w, '2026-10-13T10:05');
  eq(lastRow(w, ids.d)['위반'], '', '기록에 위반 없음');
  const r = syncOk(w, '2026-10-19T09:00:20').mails.find(isRep);
  hasNot(r && r.body, '하루 1세션 초과', '보고에도 없음');
  has(r && r.body, '(직전 취소 0건 · 사용 1건)', '이행');
});

// ================================================================== 22
scenario('22', '지운 시각을 모르면 직전 동기화 시각으로(지운 사람에게 유리), 늦게 처리한 직전 취소도 보냄', () => {
  const ids = {};
  const w = boot({ calOpts: { AFM: { deletedForm: 'minimal', getDeleted: 'notFound' } } });
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-12T10:00'); ids.j = ev(w, CAL.AFM, 'UserB(Ag)', '2026-10-13T09:00', '2026-10-13T12:00');
  syncOk(w, '2026-10-13T08:55');
  at(w, '2026-10-13T09:05'); w.calendar.remove(CAL.AFM, ids.j);
  const e = syncOk(w, '2026-10-13T09:10');
  const row = lastRow(w, ids.j);
  eq([row['상태'], row['직전취소'], fmt(row['취소시각'])], ['취소', 'N', '10-13 08:55:00'],
    '지운 시각을 모르면 직전 동기화 시각(지운 사람에게 유리)으로 판정');
  eq(e.mails.length, 0, '정상 취소로 판정되어 메일 없음');
  // 동기화가 이틀 멈췄다가 다시 돌아도, 아직 남은 시간이 있는 직전 취소는 보낸다
  at(w, '2026-10-13T10:00'); ids.d = ev(w, CAL.SPUT, 'UserA (BCP)', '2026-10-15T15:00', '2026-10-15T18:00');
  syncOk(w, '2026-10-13T10:05');
  at(w, '2026-10-15T10:00'); w.calendar.remove(CAL.SPUT, ids.d);
  const e2 = syncOk(w, '2026-10-15T12:00');
  eq(e2.mails.filter(isCan).length, 1, '늦게 처리해도 직전 취소 메일');
});

// ================================================================== 23
scenario('23', '다음 주 이후 슬롯의 취소는 메일 없이 기록만(먼 미래 일정 포함)', () => {
  const ids = {};
  const w = boot({ before: w => { at(w, '2026-10-10T10:00'); ids.m = ev(w, CAL.AFM, 'UserE(AFM)', '2026-10-21T09:00', '2026-10-21T12:00'); } });
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-16T10:00'); w.calendar.remove(CAL.AFM, ids.m);
  eq(syncOk(w, '2026-10-16T10:05').mails.length, 0, '다음 주 슬롯 취소: 바로 보내지 않음');
  eq(lastRow(w, ids.m)['상태'], '취소', '기록은 남음');
  const b = syncOk(w, '2026-10-19T09:00:20').mails.find(isBrief) || {};
  hasNot(b.body, 'UserE', '취소된 예약은 브리핑에도 나오지 않음');
  // 먼 미래(넉 달 뒤) 일정도 마찬가지
  at(w, '2026-10-19T10:00'); const far = ev(w, CAL.TE1, '가나다', '2027-02-13T11:00', '2027-02-13T12:00');
  syncOk(w, '2026-10-19T10:05');
  at(w, '2026-10-19T11:00'); w.calendar.remove(CAL.TE1, far);
  eq(syncOk(w, '2026-10-19T11:05').mails.length, 0, '먼 미래 일정 취소: 메일 없음');
});

// ================================================================== 24
scenario('24', '「예약기록」이 1,000행을 넘어도 계속 기록(시트 칸을 늘림)', () => {
  const w = boot({
    before: w => {
      at(w, '2026-10-01T10:00');
      for (let i = 0; i < 1100; i++) {
        const d = Date.parse('2026-10-12T09:00+09:00') + (i % 300) * 3 * 3600e3;
        w.calendar.create(i % 2 ? CAL.AFM : CAL.SPUT, { summary: 'User' + (i % 40), start: d, end: d + 3 * 3600e3 });
      }
    }
  });
  bootOk(w);
  eq(w.rows().length, 1100, '1100건 기록');
  check(w.sheet('예약기록').getMaxRows() >= 1101, '시트 칸이 늘어남', w.sheet('예약기록').getMaxRows());
  at(w, '2026-10-11T16:00'); ev(w, CAL.TE1, 'UserD', '2026-10-15T09:00', '2026-10-15T12:00');
  syncOk(w, '2026-10-11T16:05');
  eq(w.rows().length, 1101, '그 뒤에도 기록');
});

// ================================================================== 25
scenario('25', '파일을 이름순으로 읽어도(clasp) 동작, 바뀐 것 없는 실행은 기록 시트를 읽지 않음', () => {
  const w = new World({ now: '2026-10-11T15:00', order: 'alpha' });
  w.calendar.addCalendar(CAL.AFM, NAMES.AFM, { accessRole: 'writer' });
  [w.run('setup'), w.run('fillEquipmentSheet'), w.run('initialSync')].forEach(e => runOk(e, 'alpha ' + e.fn));
  at(w, '2026-10-12T10:00'); const id = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-14T09:00', '2026-10-14T12:00');
  syncOk(w, '2026-10-12T10:05', '이름순 syncAll');
  eq(w.rowsOf(id).length, 1, '이름순으로도 기록');
  syncOk(w, '2026-10-12T10:10');
  const before = w.sheet('예약기록').readCalls;
  syncOk(w, '2026-10-12T10:15');
  eq(w.sheet('예약기록').readCalls - before, 0, '바뀐 것 없는 실행: 기록 시트 읽기 0번');
});

// ================================================================== 26
scenario('26', '관리자 오류 메일이 실패하면 다음 실행에서 다시 시도', () => {
  const w = boot();
  w.calendar.cal(CAL.TE1).failWith = 'API call to calendar.events.list failed with error: Forbidden';
  w.mailFail = 'temporary';
  sync(w, '2026-10-12T11:10');
  w.mailFail = null;
  const e = sync(w, '2026-10-12T11:15');
  eq(e.mails.filter(m => m.to === ADMIN_TO && /동기화 오류/.test(m.subject)).length, 1, '다음 실행에서 오류 메일');
});

// ================================================================== 27
scenario('27', '이어진 겹침의 순위는 등록 순, 이름+시간 동시 변경은 취소+새 예약(정상이면 메일 없음)', () => {
  const ids = {};
  const w = boot();
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-12T10:00:01'); ids.l = ev(w, CAL.AFM, 'UserD', '2026-10-16T13:00', '2026-10-16T15:00');
  at(w, '2026-10-12T10:00:02'); ids.j = ev(w, CAL.AFM, 'UserB(Ag)', '2026-10-16T09:00', '2026-10-16T12:00');
  at(w, '2026-10-12T10:00:03'); ids.d = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-16T11:00', '2026-10-16T14:00');
  eq(syncOk(w, '2026-10-12T10:05').mails.length, 0, '중복 메일 없음');
  eq(w.eval('JSON.stringify(conflictGroups(Store.active()).map(g => g.map(r => r.booker)))'), '[["UserD","UserB","UserA"]]', '등록 순');
  at(w, '2026-10-13T10:00'); w.calendar.patch(CAL.AFM, ids.l, { summary: 'UserG(Ag)', start: '2026-10-17T09:00', end: '2026-10-17T11:00' });
  const e = syncOk(w, '2026-10-13T10:05');
  eq(w.rowsOf(ids.l).map(r => [r['예약자'], r['상태']]), [['UserD', '취소'], ['UserG', '예약']], '이름+시간 변경 = 취소 + 새 예약');
  eq(e.mails.length, 0, '정상 취소: 메일 없음');
});

// ================================================================== 28
scenario('28', '비공개였던 일정의 제목이 보이게 됨·이름 뒤에 덧붙임 = 같은 사람(양도 아님)', () => {
  const ids = {};
  const w = boot();
  at(w, '2026-10-11T18:00:05'); ids.p = ev(w, CAL.AFM, undefined, '2026-10-14T09:00', '2026-10-14T12:00', { creator: 'userg@example.com' });
  at(w, '2026-10-11T18:01'); ids.l = ev(w, CAL.SPUT, 'UserD', '2026-10-14T09:00', '2026-10-14T12:00');
  syncOk(w, '2026-10-11T18:05');
  at(w, '2026-10-13T10:00'); w.calendar.patch(CAL.AFM, ids.p, { summary: 'UserG(Ag)' });
  w.calendar.patch(CAL.SPUT, ids.l, { summary: 'UserD sample B' });
  syncOk(w, '2026-10-13T10:05');
  eq(w.rowsOf(ids.p).map(r => [r['예약자'], r['상태'], r['등록구분']]), [['UserG', '예약', '정기예약']], '제목이 보이면 이름만 채움');
  eq(w.rowsOf(ids.l).map(r => [r['예약자'], r['상태']]), [['UserD', '예약']], '덧붙인 제목 = 같은 사람');
});

// ================================================================== 29
scenario('29', '수업 예약(UserC for class)은 직전 취소·이행률·규칙 확인에서 빼고, 교수님 개인 사용(UserC)은 집계', () => {
  const ids = {};
  const w = boot({ before: w => { at(w, '2026-10-05T10:00'); ids.c1 = ev(w, CAL.AFM, 'UserC for class', '2026-10-15T13:00', '2026-10-15T16:00'); } });
  at(w, '2026-10-11T18:05'); ids.c2 = ev(w, CAL.SPUT, 'UserC for class - 마바사', '2026-10-14T13:00', '2026-10-14T16:00');
  at(w, '2026-10-11T18:06'); ids.p = ev(w, CAL.TE1, 'UserC', '2026-10-14T09:00', '2026-10-14T12:00');
  ids.p2 = ev(w, CAL.TE1, 'UserC', '2026-10-15T09:00', '2026-10-15T12:00');
  syncOk(w, '2026-10-11T18:10');
  const b = syncOk(w, '2026-10-12T09:00:20').mails.find(isBrief) || {};
  eq(lastRow(w, ids.c1)['등록구분'], '수업예약', '수업예약(일 18:00 전에 만들어도 기간전 위반 아님)');
  eq(lastRow(w, ids.c2)['예약자'], '마바사 (수업)', '대신 쓰는 사람 표시');
  eq(lastRow(w, ids.p)['예약자'], 'UserC', '이름만 쓰면 교수님 개인 사용');
  hasNot(b.body, 'UserC for class', '');
  hasNot(b.body, '[기간전예약]', '수업예약은 규칙 확인에 없음');
  at(w, '2026-10-14T10:00'); w.calendar.remove(CAL.AFM, ids.c1);
  w.calendar.remove(CAL.TE1, ids.p2);
  const m = syncOk(w, '2026-10-14T10:05').mails.find(isCan) || {};
  has(m.body, '시간: 10/15(목) 09:00–12:00', '교수님 개인 사용의 직전 취소만 알림');
  hasNot(m.body, '13:00–16:00', '수업 취소는 알리지 않음');
  eq([lastRow(w, ids.c1)['직전취소'], lastRow(w, ids.p2)['직전취소']], ['N', 'Y'], '수업 취소는 직전 취소 아님, 개인 사용은 직전 취소');
  check(m.htmlBody && m.htmlBody.indexOf('<table') > 0 && m.htmlBody.indexOf('>예약자<') > 0 && m.htmlBody.indexOf('>등록<') < 0,
    'HTML 카드(장비·시간·예약자·취소)', m.htmlBody);
  const r = syncOk(w, '2026-10-19T09:00:20').mails.find(isRep) || {};
  has(r.body, 'UserC  직전 취소 1건 · 사용 1건   [4주간 직전 취소 1건]', '교수님 개인 사용만 집계');
  hasNot(r.body, '(수업)  직전', '수업 예약은 집계에 없음');
  hasNot(r.body, '이행률에서 뺐', '설명 문구 없음');
});

// ================================================================== 30
scenario('30', '「사용자」 시트: 처음 보는 이름 자동 추가, 별칭으로 묶으면 지난 기록도 한 사람으로', () => {
  const ids = {};
  const w = boot({ before: w => { at(w, '2026-10-08T10:00'); ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-10T09:00', '2026-10-10T12:00'); } });
  const users = () => w.table('사용자').map(r => r['대표 이름']).filter(n => n.indexOf('(예)') !== 0);
  eq(users(), ['UserA'], 'initialSync로 기존 예약자 추가');
  at(w, '2026-10-11T18:10'); ids.a = ev(w, CAL.AFM, 'usera (Ag)', '2026-10-13T09:00', '2026-10-13T12:00');
  ids.b = ev(w, CAL.SPUT, '나다', '2026-10-14T09:00', '2026-10-14T12:00');
  ids.c = ev(w, CAL.TE1, 'UserC for class', '2026-10-15T13:00', '2026-10-15T16:00');
  ids.d = ev(w, CAL.TE1, undefined, '2026-10-16T09:00', '2026-10-16T12:00', { creator: 'x@example.com' });
  syncOk(w, '2026-10-11T18:15');
  eq(users(), ['UserA', '나다', 'UserC'], '새 이름만 추가(대소문자 같은 이름·제목 없음 제외, 수업은 이름만)');
  syncOk(w, '2026-10-11T18:20');
  eq(users().length, 3, '다시 돌아도 중복 추가 없음');
  // 관리자가 '나다'을 UserA의 별칭으로 묶고 '나다' 행을 지움
  const sh = w.sheet('사용자');
  const rowOf = n => w.table('사용자').find(r => r['대표 이름'] === n)._row;
  sh.getRange(rowOf('UserA'), 2).setValue('나다');
  sh.getRange(rowOf('나다'), 1, 1, 2).setValues([['', '']]);
  syncOk(w, '2026-10-19T09:00:20');
  const wk = w.table('주간보고');
  eq(wk.filter(x => x['예약자'] === 'UserA').map(x => x['사용']), [2], '묶은 표기는 주간보고에서 한 사람(사용 2)');
  eq(wk.filter(x => x['예약자'] === '나다').length, 0, '따로 나오지 않음');
  // 이름 칸을 비웠다가 fillUserSheet를 돌리면 기록된 이름 중 없는 것만 다시 채움(별칭으로 묶인 나다은 제외)
  sh.getRange(rowOf('UserC'), 1, 1, 2).setValues([['', '']]);
  runOk(w.run('fillUserSheet'));
  eq(users().filter(Boolean).sort(), ['UserA', 'UserC'].sort(), 'fillUserSheet: 빠진 이름만 채움');
});

// ================================================================== 31
scenario('31', '시트 보호: 4개 시트를 관리자만 수정, 여러 번 실행해도 보호 하나, 보호해도 기록은 계속', () => {
  const w = boot();
  bootOk(w);
  runOk(w.run('protectSheets'));
  const ps = ['장비', '사용자', '예약기록', '주간보고'].map(n => w.sheet(n).getProtections());
  eq(ps.map(p => p.length), [1, 1, 1, 1], '시트마다 보호 하나(setup + 다시 실행)');
  eq(ps.map(p => [p[0].editors.length, p[0].domainEdit]), [[0, false], [0, false], [0, false], [0, false]], '다른 편집자 없음');
  at(w, '2026-10-11T16:00'); const id = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-14T09:00', '2026-10-14T12:00');
  syncOk(w, '2026-10-11T16:05');
  eq(w.rowsOf(id).length, 1, '보호 뒤에도 기록');
});

// ================================================================== 32
scenario('32', '정기예약 기간에 만든 반복 일정(화~목) = 정기예약', () => {
  const w = boot();
  at(w, '2026-10-11T18:00:29');
  const ids = w.calendar.createRecurring(CAL.TE1, { summary: 'UserE(Ag)', start: '2026-10-13T12:00', end: '2026-10-13T15:00' },
    ['2026-10-13T12:00', '2026-10-14T12:00', '2026-10-15T12:00']);
  syncOk(w, '2026-10-11T18:05');
  eq(ids.map(id => lastRow(w, id)['등록구분']), ['정기예약', '정기예약', '정기예약'], '반복 일정도 정기예약');
  eq(ids.map(id => lastRow(w, id)['위반']), ['', '', ''], '날마다 1세션이라 위반 없음');
});

// ================================================================== 33
scenario('33', '기간전예약 개인 메일: 반복 일정이 다음 주 이후까지 이어지면 예약자에게 한 통(사용자 시트 이메일), 그룹에는 없음', () => {
  const w = boot();
  syncOk(w, '2026-10-12T09:00:20');
  // 사용자 시트에 이메일을 적어 둠
  w.sheet('사용자').appendRow(['UserE', '', 'usere@example.com']);
  at(w, '2026-10-13T10:00');
  const ids = w.calendar.createRecurring(CAL.TE1, { summary: 'UserE(Ag)', start: '2026-10-15T12:00', end: '2026-10-15T15:00' },
    ['2026-10-15T12:00', '2026-10-22T12:00', '2026-10-29T12:00']);
  const e = syncOk(w, '2026-10-13T10:05');
  eq(ids.map(id => lastRow(w, id)['등록구분']), ['추가예약', '기간전예약', '기간전예약'], '이번 주 회차 = 추가예약, 다음 주 이후 = 기간전예약');
  const m = e.mails.find(x => /기간전예약 안내/.test(x.subject)) || {};
  eq([e.mails.length, m.to], [1, 'usere@example.com'], '예약자에게만 한 통');
  has(m.subject, '기간전예약 안내 · UserE · 10/22(목) 12:00–15:00 외 1건', '제목');
  has(m.body, '(예약 시작 10/18(일) 18:00)', '언제부터 예약할 수 있는지');
  has(m.body, '반복 종료일을 줄여 주세요', '반복 일정 안내');
  eq(syncOk(w, '2026-10-13T10:10').mails.length, 0, '다시 보내지 않음');
  // 이메일이 없는 사람: 일정을 만든 계정, 그것도 관리자 계정이면 관리자에게
  at(w, '2026-10-13T11:00');
  w.calendar.create(CAL.AFM, { summary: 'UserD', start: '2026-10-21T09:00', end: '2026-10-21T12:00', creator: 'userd@example.com' });
  w.calendar.create(CAL.SPUT, { summary: 'UserF', start: '2026-10-21T09:00', end: '2026-10-21T12:00', creator: ADMIN });
  const e2 = syncOk(w, '2026-10-13T11:05');
  eq(e2.mails.map(x => x.to).sort(), [ADMIN_TO, 'userd@example.com'].sort(), '만든 계정으로, 공용 계정이면 관리자에게');
  has((e2.mails.find(x => x.to === ADMIN_TO) || {}).subject, '(주소 없음)', '관리자 메일 표시');
  // 기간전예약을 지우면 직전 취소 아님, 그룹 메일 없음(다음 주 슬롯)
  at(w, '2026-10-13T12:00'); w.calendar.remove(CAL.TE1, ids[1]);
  const e3 = syncOk(w, '2026-10-13T12:05');
  eq([e3.mails.length, lastRow(w, ids[1])['직전취소']], [0, 'N'], '지워도 메일 없음, 직전 취소 아님');
});

// ================================================================== 34
scenario('34', '「예약기록」은 등록시각 내림차순으로 정렬, 사람이 순서를 바꿔도 남겨 둔 알림은 맞는 기록을 찾음', () => {
  const ids = {};
  const w = boot();
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-12T10:00'); ids.a = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-13T15:00', '2026-10-13T18:00');
  at(w, '2026-10-12T11:00'); ids.b = ev(w, CAL.SPUT, 'UserD', '2026-10-14T09:00', '2026-10-14T12:00');
  at(w, '2026-10-12T12:00'); ids.c = ev(w, CAL.TE1, 'UserF(Ag)', '2026-10-15T09:00', '2026-10-15T12:00');
  syncOk(w, '2026-10-12T12:05');
  const order = () => w.table('예약기록').filter(r => r['일정ID'] !== '').map(r => r['예약자']);
  eq(order().slice(0, 3), ['UserF', 'UserD', 'UserA'], '최신 등록이 위');
  // 직전 취소 메일 발송 실패 → 남겨 둔 알림
  at(w, '2026-10-13T10:00'); w.calendar.remove(CAL.AFM, ids.a);
  w.mailFail = 'temporary';
  sync(w, '2026-10-13T10:05');
  w.mailFail = null;
  // 사람이 시트를 다른 순서(오름차순)로 바꿔 놓음
  const sh = w.sheet('예약기록');
  sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).sort({ column: 8, ascending: true });
  eq(order()[0] !== 'UserF', true, '순서가 바뀜');
  const e = syncOk(w, '2026-10-13T10:10');
  const m = e.mails.find(isCan) || {};
  has(m.body, '예약자: UserA', '남겨 둔 알림이 맞는 기록(UserA)을 찾아 보냄');
  has(m.body, '시간: 10/13(화) 15:00–18:00', '맞는 시간');
});

// ================================================================== 35
scenario('35', '위반 표시는 다시 계산(겹침이 풀리면 지움), 사용 시작 뒤 제목 변경은 메모(양도 아님)', () => {
  const ids = {};
  const w = boot();
  syncOk(w, '2026-10-12T09:00:20');
  // 긴 일정(13:00~다음 날 13:00)이 있는 상태에서 UserF가 다음 날 09~12 예약 → 겹침 표시
  at(w, '2026-10-12T10:00'); ids.long = ev(w, CAL.TE1, 'UserB(Ag)', '2026-10-13T13:00', '2026-10-14T13:00');
  syncOk(w, '2026-10-12T10:05');
  at(w, '2026-10-12T11:00'); ids.j = ev(w, CAL.TE1, 'UserF(Ag)', '2026-10-14T09:00', '2026-10-14T12:00');
  syncOk(w, '2026-10-12T11:05');
  has(lastRow(w, ids.j)['위반'], '다른 예약과 시간 겹침(UserB)', '처음에는 겹침 표시');
  w.configOverrides.LOG_PERSONAL_DETAILS = true; // 합성 데이터 상세 확인을 명시적으로 허용한다.
  w.at('2026-10-12T11:06'); const ex = w.run('explainFlags'); runOk(ex);
  has(ex.logs.join(String.fromCharCode(10)), '겹치는 일정: 「UserB(Ag)」 예약자 UserB · 10/13(화) 13:00–10/14(수) 13:00', 'explainFlags: 겹치는 상대 일정');
  // 긴 일정을 18:00까지로 줄임 → 다음 동기화에서 UserF의 겹침 표시가 사라짐
  at(w, '2026-10-12T12:00'); w.calendar.patch(CAL.TE1, ids.long, { end: '2026-10-13T18:00' });
  syncOk(w, '2026-10-12T12:05');
  eq(lastRow(w, ids.j)['위반'], '', '겹침이 풀리면 표시도 지움');
  // 사용이 끝난 뒤 제목을 장비 상태 메모로 바꿈 → 양도 아님, 예약자 그대로
  at(w, '2026-10-13T19:00'); w.calendar.patch(CAL.TE1, ids.long, { summary: 'Evaporator-Completed' });
  syncOk(w, '2026-10-13T19:05');
  eq(w.rowsOf(ids.long).map(r => [r['예약자'], r['상태'], r['제목']]), [['UserB', '예약', 'Evaporator-Completed']], '메모로 보고 예약자 유지');
  eq(w.table('사용자').some(r => r['대표 이름'] === 'Evaporator-Completed'), false, '사용자 시트에 메모가 이름으로 들어가지 않음');
});

// ================================================================== 36
scenario('36', '[Fix] 점검 일정: 예약자 「점검」, 사용자 시트·이행률·직전 취소에서 제외, 겹침은 표시(점검이 1순위)', () => {
  const ids = {};
  const w = boot();
  at(w, '2026-10-11T11:51'); ids.old = ev(w, CAL.TE1, '[Fix] Evaporator', '2026-10-11T14:00', '2026-10-12T13:00');
  syncOk(w, '2026-10-11T11:55');
  eq([lastRow(w, ids.old)['예약자'], lastRow(w, ids.old)['등록구분']], ['점검', '점검'], '[Fix] = 점검');
  eq(w.table('사용자').some(r => /Evaporator|점검/.test(r['대표 이름'])), false, '사용자 시트에 들어가지 않음');
  // 점검과 겹치는 예약: 겹침 표시, 순위는 점검 먼저
  at(w, '2026-10-11T21:51'); ids.j = ev(w, CAL.TE1, 'UserF(Ag)', '2026-10-12T09:00', '2026-10-12T12:00');
  syncOk(w, '2026-10-11T21:55');
  has(lastRow(w, ids.j)['위반'], '다른 예약과 시간 겹침(점검)', '점검과 겹침 표시');
  eq(w.eval('JSON.stringify(conflictGroups(Store.active()).map(g => g.map(r => r.booker)))'), '[["점검","UserF"]]', '점검이 1순위');
  // 점검을 사용 중에 줄여도 직전 취소 아님, 메일 없음
  at(w, '2026-10-11T22:00'); w.calendar.patch(CAL.TE1, ids.old, { start: '2026-10-10T14:00', end: '2026-10-11T12:00' });
  const e = syncOk(w, '2026-10-11T22:05');
  eq(e.mails.length, 0, '점검 일정 변경: 메일 없음');
  eq(w.rowsOf(ids.old).filter(r => r['직전취소'] === 'Y').length, 0, '점검은 직전 취소 아님');
  eq(lastRow(w, ids.j)['위반'], '', '점검이 옮겨지면 겹침 표시도 지움');
  // 이행률 보고에 점검이 나오지 않음
  at(w, '2026-10-13T10:00'); const f2 = ev(w, CAL.AFM, '[Fix] AFM tip change', '2026-10-15T09:00', '2026-10-15T12:00');
  syncOk(w, '2026-10-13T10:05');
  at(w, '2026-10-15T10:00'); w.calendar.remove(CAL.AFM, f2);
  eq(syncOk(w, '2026-10-15T10:05').mails.length, 0, '점검 취소: 메일 없음');
  const b = syncOk(w, '2026-10-19T09:00:20').mails.find(isBrief) || {};
  hasNot(b.body, '점검  직전', '직전 취소 목록에 점검 없음');
});

// ================================================================== 37
scenario('37', '하루 제한 제외 장비(DAY_LIMIT_EXEMPT): 그 장비는 하루 1세션 초과 표시 없음, 바꾼 뒤 그 장비에 변경이 생기면 옛 표시도 지움', () => {
  const ids = {};
  const w = boot();
  at(w, '2026-10-11T21:30'); ids.h = ev(w, CAL.AFM, 'UserG(AFM)', '2026-10-12T13:00', '2026-10-12T18:00');
  ids.s = ev(w, CAL.SPUT, 'UserG(Ag)', '2026-10-12T13:00', '2026-10-12T18:00');
  syncOk(w, '2026-10-11T21:35');
  has(lastRow(w, ids.h)['위반'], '하루 1세션 초과', '제외 전: AFM 13~18 = 2세션 초과');
  w.configOverrides = { DAY_LIMIT_EXEMPT: [CAL.AFM] };
  at(w, '2026-10-11T21:38'); w.calendar.patch(CAL.AFM, ids.h, { end: '2026-10-12T17:00' }); // 그 장비에 변경이 생기면 다시 계산
  syncOk(w, '2026-10-11T21:40');
  eq(lastRow(w, ids.h)['위반'], '', 'AFM은 제외: 옛 표시도 지움');
  has(lastRow(w, ids.s)['위반'], '하루 1세션 초과', '다른 장비는 그대로');
});

// ================================================================== 38
scenario('38', '지난주 직전 취소 목록: 누적 직전 취소가 같으면 사용이 적은 사람 먼저', () => {
  const w = boot();
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-12T10:00');
  // UserA: 사용 3 · 직전 취소 1 = 75%, UserD: 사용 0 · 직전 취소 1 = 0%, UserF: 사용 1 · 직전 취소 1 = 50%
  const g = ['13', '14', '15', '16'].map(d => ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-' + d + 'T15:00', '2026-10-' + d + 'T18:00'));
  const m = ev(w, CAL.SPUT, 'UserD', '2026-10-14T15:00', '2026-10-14T18:00');
  const j = ['15', '16'].map(d => ev(w, CAL.TE1, 'UserF(Ag)', '2026-10-' + d + 'T15:00', '2026-10-' + d + 'T18:00'));
  syncOk(w, '2026-10-12T10:05');
  at(w, '2026-10-13T10:00'); w.calendar.remove(CAL.AFM, g[0]);
  at(w, '2026-10-14T10:00'); w.calendar.remove(CAL.SPUT, m);
  at(w, '2026-10-15T10:00'); w.calendar.remove(CAL.TE1, j[0]);
  syncOk(w, '2026-10-15T10:05');
  const b = (syncOk(w, '2026-10-19T09:00:20').mails.find(isBrief) || {}).body || '';
  const order = ['UserD', 'UserF', 'UserA'].map(n => b.indexOf('  ' + n + '  직전 취소 1건'));
  check(order.every(i => i > 0) && order[0] < order[1] && order[1] < order[2], '사용 0 → 1 → 3건 순', b);
});

// ================================================================== 39
scenario('39', '「예약기록」 열: 사람이 보는 순서, 스크립트용 열 숨김, 관리자가 바꾼 순서도 열 제목으로 제자리에', () => {
  const NEW = ['등록시각', '예약자', '장비', '시작', '종료', '등록구분', '상태', '취소시각', '직전취소', '직전취소기준', '제외사유',
    '위반', '제목', '비고', '만든계정', '캘린더ID', '일정ID', '마감시작', '마감종료'];
  const ids = {};
  const w = boot();
  const s = w.sheet('예약기록');
  eq(s.cells[0].slice(0, NEW.length), NEW, '새로 설치: 사람이 보는 순서');
  eq([16, 17, 18, 19].map(c => s.isColumnHiddenByUser(c)), [true, true, true, true], '캘린더ID·일정ID·마감시작·마감종료 숨김');
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-13T11:00'); ids.d = ev(w, CAL.SPUT, 'UserG', '2026-10-15T09:00', '2026-10-15T12:00');
  syncOk(w, '2026-10-13T11:05');
  // 관리자가 열 순서를 바꿈(예약자 ↔ 장비) → 되돌리지 않고, 기록은 열 제목을 보고 읽고 씀
  s.cells.forEach(row => { const x = row[1]; row[1] = row[2]; row[2] = x; });
  at(w, '2026-10-15T09:10'); w.calendar.remove(CAL.SPUT, ids.d);
  const e = syncOk(w, '2026-10-15T09:15');
  at(w, '2026-10-15T10:00'); ids.f = ev(w, CAL.TE1, 'UserH(Ag)', '2026-10-16T09:00', '2026-10-16T12:00');
  syncOk(w, '2026-10-15T10:05');
  eq(s.cells[0].slice(0, 3), ['등록시각', '장비', '예약자'], '관리자가 바꾼 순서 유지');
  eq([lastRow(w, ids.f)['예약자'], lastRow(w, ids.f)['장비']], ['UserH', NAMES.TE1], '바꾼 순서에서도 새 기록이 제 열에');
  eq([lastRow(w, ids.d)['예약자'], lastRow(w, ids.d)['상태'], lastRow(w, ids.d)['직전취소']], ['UserG', '취소', 'Y'], '앞선 기록의 고침도 제 열에');
  eq(e.mails.filter(isCan).length, 1, '직전 취소 메일');
});

// ================================================================== 40
scenario('40', '같은 시간 양도 뒤 새 예약자의 직전 취소·변경도 [예약취소] 메일(양도 행과 열쇠가 같아도)', () => {
  const mk = () => {
    const ids = {};
    const w = boot();
    syncOk(w, '2026-10-12T09:00:20');
    at(w, '2026-10-12T10:00'); ids.e = ev(w, CAL.TE1, 'UserF(Ag)', '2026-10-14T15:00', '2026-10-14T18:00');
    syncOk(w, '2026-10-12T10:05');
    at(w, '2026-10-13T10:00'); w.calendar.patch(CAL.TE1, ids.e, { summary: 'UserD' });
    syncOk(w, '2026-10-13T10:05');
    return { w, ids };
  };
  let { w, ids } = mk();
  at(w, '2026-10-14T10:00'); w.calendar.remove(CAL.TE1, ids.e);
  let e = syncOk(w, '2026-10-14T10:05');
  eq(w.rowsOf(ids.e).map(r => [r['예약자'], r['상태'], r['직전취소']]), [['UserF', '양도', ''], ['UserD', '취소', 'Y']], '기록: 양도 → 직전 취소');
  const m = e.mails.find(isCan) || {};
  eq(e.mails.filter(isCan).length, 1, '직전 취소 메일 한 통');
  has(m.body, 'UserD', '예약자는 넘겨받은 사람');
  ({ w, ids } = mk());
  at(w, '2026-10-14T10:00'); w.calendar.patch(CAL.TE1, ids.e, { start: '2026-10-16T15:00', end: '2026-10-16T18:00' });
  e = syncOk(w, '2026-10-14T10:05');
  eq(e.mails.filter(isCan).length, 1, '넘겨받은 사람이 직전에 다른 날로 옮김: 메일 한 통');
  ({ w, ids } = mk());
  at(w, '2026-10-13T11:00'); w.calendar.patch(CAL.TE1, ids.e, { summary: 'UserF(Ag)' });
  syncOk(w, '2026-10-13T11:05');
  at(w, '2026-10-14T10:00'); w.calendar.remove(CAL.TE1, ids.e);
  e = syncOk(w, '2026-10-14T10:05');
  eq(e.mails.filter(isCan).length, 1, 'UserF → UserD → UserF 뒤 직전 취소: 메일 한 통');
});

// ================================================================== 41
scenario('41', '사용 시작 뒤 제목 변경(메모)은 구분도 그대로: [Fix] → 메모는 점검 유지, 사람 → [Fix] 제목은 사람 예약 유지', () => {
  const ids = {};
  let w = boot({ before: w => { at(w, '2026-10-01T10:00'); ids.fix = ev(w, CAL.TE1, '[Fix] Evaporator', '2026-10-13T09:00', '2026-10-14T18:00'); } });
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-13T12:00'); w.calendar.patch(CAL.TE1, ids.fix, { summary: 'Evaporator-Completed' });
  syncOk(w, '2026-10-13T12:05');
  eq([lastRow(w, ids.fix)['예약자'], lastRow(w, ids.fix)['등록구분'], lastRow(w, ids.fix)['위반']], ['점검', '점검', ''], '메모 뒤에도 점검');
  at(w, '2026-10-13T13:00'); w.calendar.remove(CAL.TE1, ids.fix);
  let e = syncOk(w, '2026-10-13T13:05');
  eq([lastRow(w, ids.fix)['직전취소'], e.mails.filter(isCan).length], ['N', 0], '점검 삭제: 직전 취소 아님, 메일 없음');
  const b = syncOk(w, '2026-10-19T09:00:20').mails.find(isBrief) || {};
  eq(w.table('주간보고').some(r => r['예약자'] === '점검'), false, '주간보고에 점검 없음');
  hasNot(b.body, '점검  직전', '브리핑 직전 취소 목록에 점검 없음');

  w = boot();
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-12T10:00'); ids.e = ev(w, CAL.TE1, 'UserF(Ag)', '2026-10-14T09:00', '2026-10-14T18:00');
  syncOk(w, '2026-10-12T10:05');
  at(w, '2026-10-14T10:00'); w.calendar.patch(CAL.TE1, ids.e, { summary: '[Fix] pump noise' });
  syncOk(w, '2026-10-14T10:05');
  at(w, '2026-10-14T10:30'); w.calendar.remove(CAL.TE1, ids.e);
  syncOk(w, '2026-10-14T10:35');
  eq([lastRow(w, ids.e)['예약자'], lastRow(w, ids.e)['등록구분'], lastRow(w, ids.e)['직전취소']], ['UserF', '추가예약', 'Y'],
    '사람 예약은 그대로, 사용 시작 뒤 삭제 = 직전 취소');
});

// ================================================================== 42
scenario('42', '[Fix] 생성과 겹치는 예약 삭제가 같은 동기화에 들어와도 따로 들어온 것과 같은 판정', () => {
  const run = (fixFirst, same) => {
    const ids = {};
    const w = boot();
    syncOk(w, '2026-10-12T09:00:20');
    at(w, '2026-10-12T10:00'); ids.j = ev(w, CAL.TE1, 'UserF(Ag)', '2026-10-14T15:00', '2026-10-14T18:00');
    syncOk(w, '2026-10-12T10:05');
    const fix = () => ev(w, CAL.TE1, '[Fix] Evaporator broken', '2026-10-14T10:00', '2026-10-15T18:00');
    const del = () => w.calendar.remove(CAL.TE1, ids.j);
    at(w, '2026-10-14T10:00'); (fixFirst ? fix : del)();
    if (!same) syncOk(w, '2026-10-14T10:01');
    at(w, '2026-10-14T10:03'); (fixFirst ? del : fix)();
    syncOk(w, '2026-10-14T10:05');
    const r = lastRow(w, ids.j);
    return [r['직전취소'], r['제외사유']];
  };
  eq([run(true, false), run(true, true)], [['N', '양보'], ['N', '양보']], '점검이 먼저 생김: 따로·같은 주기 모두 양보');
  eq([run(false, false), run(false, true)], [['Y', ''], ['Y', '']], '지운 뒤에 점검이 생김: 따로·같은 주기 모두 직전 취소');
});

// ================================================================== 43
scenario('43', '수업·점검 시간을 시작 전에 사람에게 넘기면 넘겨받은 시각에 등록한 예약(사람 사이 양도는 그대로 이어받음)', () => {
  const ids = {};
  let w = boot({ before: w => { at(w, '2026-09-30T10:00'); ids.fix = ev(w, CAL.TE1, '[Fix] Evaporator', '2026-10-14T09:00', '2026-10-14T18:00'); } });
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-13T10:00'); w.calendar.patch(CAL.TE1, ids.fix, { summary: 'UserF(Ag)' });
  syncOk(w, '2026-10-13T10:05');
  eq([lastRow(w, ids.fix)['예약자'], lastRow(w, ids.fix)['등록구분'], lastRow(w, ids.fix)['위반']], ['UserF', '추가예약', ''], '점검 → UserF: 추가예약, 위반 없음');

  w = boot({ before: w => { at(w, '2026-09-01T10:00'); ids.c = ev(w, CAL.TE1, 'UserC for class', '2026-10-14T15:00', '2026-10-14T18:00'); } });
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-14T10:00'); w.calendar.patch(CAL.TE1, ids.c, { summary: 'UserF(Ag)' });
  syncOk(w, '2026-10-14T10:05');
  eq([lastRow(w, ids.c)['등록구분'], lastRow(w, ids.c)['위반']], ['추가예약', ''], '수업 → UserF: 추가예약, 위반 없음');

  // 다음 주 이후 점검 시간을 넘겨받음 = 넘겨받은 시각 기준 기간전예약 → 개인 메일
  w = boot({ before: w => { at(w, '2026-09-30T10:00'); ids.f2 = ev(w, CAL.TE1, '[Fix] Evaporator', '2026-10-21T09:00', '2026-10-21T12:00'); } });
  syncOk(w, '2026-10-12T09:00:20');
  w.sheet('사용자').appendRow(['UserF', '', 'userf@example.com']);
  at(w, '2026-10-13T10:00'); w.calendar.patch(CAL.TE1, ids.f2, { summary: 'UserF(Ag)' });
  const e = syncOk(w, '2026-10-13T10:05');
  eq(lastRow(w, ids.f2)['등록구분'], '기간전예약', '다음 주 점검 시간 → 기간전예약');
  eq(e.mails.filter(m => /기간전예약/.test(m.subject)).map(m => m.to), ['userf@example.com'], '넘겨받은 사람에게 개인 메일');

  w = boot();
  at(w, '2026-10-11T18:30'); ids.e = ev(w, CAL.TE1, 'UserD', '2026-10-14T15:00', '2026-10-14T18:00');
  syncOk(w, '2026-10-11T18:35');
  at(w, '2026-10-13T10:00'); w.calendar.patch(CAL.TE1, ids.e, { summary: 'UserF(Ag)' });
  syncOk(w, '2026-10-13T10:05');
  eq(lastRow(w, ids.e)['등록구분'], '정기예약', '사람 → 사람 양도는 정기예약을 이어받음');
});

// ================================================================== 44
scenario('44', '기간전예약 메일 발송 실패 뒤 같은 예약을 지우고 다시 만들거나 시간을 조정해도 메일은 나감', () => {
  for (const how of ['recreate', 'adjust']) {
    const ids = {};
    const w = boot();
    syncOk(w, '2026-10-12T09:00:20');
    at(w, '2026-10-12T10:00'); ids.e = ev(w, CAL.TE1, 'UserF(Ag)', '2026-10-27T09:00', '2026-10-27T12:00', { creator: 'userf@example.com' });
    w.mailFail = 'temporary';
    sync(w, '2026-10-12T10:05');
    w.mailFail = null;
    if (how === 'recreate') {
      at(w, '2026-10-12T10:10'); w.calendar.remove(CAL.TE1, ids.e);
      at(w, '2026-10-12T10:11'); ev(w, CAL.TE1, 'UserF(Ag)', '2026-10-27T09:00', '2026-10-27T12:00', { creator: 'userf@example.com' });
    } else {
      at(w, '2026-10-12T10:10'); w.calendar.patch(CAL.TE1, ids.e, { start: '2026-10-27T10:00' });
    }
    const e = syncOk(w, '2026-10-12T10:15');
    eq(e.mails.filter(m => /기간전예약/.test(m.subject)).length, 1, how + ': 기간전예약 메일 한 통');
  }
});

// ================================================================== 45
scenario('45', '하루 한 번 채운 반복 회차와 겹치는 기존 예약도 위반 칸에 겹침 표시, 관리자가 더한 열은 정렬 뒤에도 같은 행', () => {
  const ids = {};
  const w = boot();
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-12T10:00');
  const inst = w.calendar.createRecurring(CAL.AFM, { summary: 'UserE(AFM)', start: '2026-10-15T09:00', end: '2026-10-15T12:00' },
    ['2026-10-15T09:00', '2026-10-22T09:00', '2026-10-29T09:00', '2026-11-05T09:00', '2026-11-12T09:00']);
  syncOk(w, '2026-10-12T10:05');
  at(w, '2026-10-12T11:00'); ids.g = ev(w, CAL.AFM, 'UserA', '2026-11-12T10:00', '2026-11-12T13:00');
  syncOk(w, '2026-10-12T11:05');
  eq(w.rowsOf(inst[4]).length, 0, '11/12 회차는 아직 기록 밖');
  syncOk(w, '2026-10-16T09:10');
  has(lastRow(w, inst[4])['위반'], '겹침(UserA)', '채운 회차에 겹침');
  has(lastRow(w, ids.g)['위반'], '겹침(UserE)', '기존 예약에도 겹침');
  // 관리자 메모 열
  const sh = w.sheet('예약기록');
  const memo = sh.getLastColumn() + 1;
  sh.getRange(1, memo).setValue('관리자 메모');
  sh.getRange(lastRow(w, ids.g)._row, memo).setValue('UserA 메모');
  at(w, '2026-10-16T10:00'); ev(w, CAL.SPUT, 'UserD', '2026-10-17T09:00', '2026-10-17T12:00');
  syncOk(w, '2026-10-16T10:05');
  eq(lastRow(w, ids.g)['관리자 메모'], 'UserA 메모', '정렬 뒤에도 메모가 UserA 행에');
  eq(w.rows().filter(r => r['관리자 메모'] === 'UserA 메모').length, 1, '다른 행으로 옮겨 가지 않음');
});

// ================================================================== 46
// 직전 취소 빨간색: 이 스크립트가 만든 조건부 서식 규칙과, 그 규칙에 걸리는 행
const lateRule = sh => sh.cfRules.find(r => /^=\$[A-Z]+2="Y"$/.test(r.formula || ''));
const redRows = sh => {
  const r = lateRule(sh);
  if (!r) return [];
  const col = r.formula.charCodeAt(2) - 64;
  const g = r.ranges[0];
  const out = [];
  for (let row = g.row; row < g.row + g.nr && row <= sh.getLastRow(); row++) if ((sh.cells[row - 1] || [])[col - 1] === 'Y') out.push(row);
  return out;
};
scenario('46', '직전 취소 행은 빨간색(조건부 서식): 정렬·새 행에도, 다시 설치해도 규칙 하나, 관리자 규칙은 그대로', () => {
  const ids = {};
  const w = boot();
  const sh = w.sheet('예약기록');
  const rule = lateRule(sh) || {};
  eq([rule.formula, rule.background, rule.fontColor], ['=$I2="Y"', '#f8d7da', '#b3261e'], '직전취소 열(I) = Y면 옅은 빨강 배경·빨간 글자');
  eq([sh.cells[0][8], rule.ranges && rule.ranges[0].row, rule.ranges && rule.ranges[0].col, rule.ranges && rule.ranges[0].nc >= 19],
    ['직전취소', 2, 1, true], '2행부터 모든 열');
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-12T10:00'); ids.a = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-13T09:00', '2026-10-13T12:00');
  ids.b = ev(w, CAL.SPUT, 'UserD', '2026-10-14T09:00', '2026-10-14T12:00');
  syncOk(w, '2026-10-12T10:05');
  at(w, '2026-10-12T11:00'); w.calendar.remove(CAL.SPUT, ids.b);                 // 정상 취소
  at(w, '2026-10-13T09:30'); w.calendar.remove(CAL.AFM, ids.a);                  // 직전 취소
  syncOk(w, '2026-10-13T09:35');
  eq(redRows(sh), [lastRow(w, ids.a)._row], '직전 취소 행만 빨간색(정상 취소는 아님)');
  // 시트 칸이 꽉 찬 뒤 새 기록 → 칸을 늘리고 규칙 범위도 넓힘
  sh.maxRows = sh.getLastRow();
  at(w, '2026-10-13T10:00'); ev(w, CAL.TE1, 'UserF(Ag)', '2026-10-15T09:00', '2026-10-15T12:00');
  syncOk(w, '2026-10-13T10:05');
  const g = lateRule(sh).ranges[0];
  eq(g.row + g.nr - 1 >= sh.getMaxRows(), true, '늘린 행까지 규칙 범위');
  // 관리자가 만든 다른 규칙이 있어도 다시 설치하면 우리 규칙만 바꿈
  sh.cfRules.push({ formula: '=$B2="UserA"', background: '#ffff00', ranges: [], getBooleanCondition: () => ({ getCriteriaType: () => 'CUSTOM_FORMULA', getCriteriaValues: () => ['=$B2="UserA"'] }) });
  runOk(w.run('setup'));
  eq([sh.cfRules.filter(r => /^=\$[A-Z]+2="Y"$/.test(r.formula)).length, sh.cfRules.some(r => r.formula === '=$B2="UserA"')], [1, true], '규칙 하나, 관리자 규칙 유지');
});

// ================================================================== 49
scenario('49', '브리핑 지난주 직전 취소: 사람마다 지난주 직전 취소·사용과 4주간(지난주까지) 직전 취소, 4주 지난 것은 빠짐, 이행률은 보이지 않음', () => {
  const w = boot();
  syncOk(w, '2026-10-12T09:00:20');
  const book = (cal, name, day) => ev(w, cal, name, day + 'T15:00', day + 'T18:00');
  const lateCancel = (cal, id, day) => { at(w, day + 'T16:00'); w.calendar.remove(cal, id); syncOk(w, day + 'T16:05'); };
  // 10/12 주: UserA 직전 취소 1 · 사용 1, UserD 직전 취소 1
  at(w, '2026-10-12T10:00');
  const g1 = book(CAL.AFM, 'UserA (BCP)', '2026-10-13'); book(CAL.AFM, 'UserA (BCP)', '2026-10-14');
  const m1 = book(CAL.SPUT, 'UserD', '2026-10-13');
  syncOk(w, '2026-10-12T10:05');
  lateCancel(CAL.AFM, g1, '2026-10-13'); lateCancel(CAL.SPUT, m1, '2026-10-13');
  // 10/26 주: UserA 직전 취소 1
  syncOk(w, '2026-10-26T09:00:20');
  at(w, '2026-10-26T10:00'); const g3 = book(CAL.AFM, 'UserA (BCP)', '2026-10-27');
  syncOk(w, '2026-10-26T10:05');
  lateCancel(CAL.AFM, g3, '2026-10-27');
  // 11/02 주(지난주): UserA 직전 취소 1 · 사용 1
  syncOk(w, '2026-11-02T09:00:20');
  at(w, '2026-11-02T10:00'); const g4 = book(CAL.AFM, 'UserA (BCP)', '2026-11-03'); book(CAL.AFM, 'UserA (BCP)', '2026-11-04');
  syncOk(w, '2026-11-02T10:05');
  lateCancel(CAL.AFM, g4, '2026-11-03');
  let b = syncOk(w, '2026-11-09T09:00:20').mails.find(isBrief) || {};
  has(b.body, '■ 지난주 직전 취소  (직전 취소 1건 · 사용 1건)', '지난주 합계');
  has(b.body, '  UserA  직전 취소 1건 · 사용 1건   [4주간 직전 취소 3건]', '지난주 1·1, 10/12~11/08 네 주 누적 3');
  has(b.body, '11/03(화) 15:00–18:00 [LAB-A] Atomic Force Microscope   [취소 11/03(화) 16:00]', '지난주 직전 취소 시간');
  hasNot(b.body, 'UserD  직전 취소', '지난주에 직전 취소가 없으면 나오지 않음');
  has(b.htmlBody, '<b>UserA</b> · 직전 취소 1건 · 사용 1건</td><td align="right" valign="top" style="padding:0 0 0 12px;white-space:nowrap;color:#374151">4주간 직전 취소 3건</td>',
    'HTML: 4주간 직전 취소는 같은 줄 오른쪽 끝에 따로');
  has(b.htmlBody, '11/03(화) 15:00–18:00 · [LAB-A] Atomic Force Microscope</td><td align="right" valign="top" style="padding:0 0 0 12px;white-space:nowrap;color:#6b7280;font-size:13px">취소 11/03(화) 16:00</td>',
    'HTML: 취소 시각도 오른쪽 끝에 따로');
  hasNot(b.body + b.htmlBody, '이행률', '이행률 문구 없음');
  // 다음 주: 10/12 주는 4주 밖으로
  at(w, '2026-11-09T10:00'); const g5 = book(CAL.AFM, 'UserA (BCP)', '2026-11-10');
  syncOk(w, '2026-11-09T10:05');
  lateCancel(CAL.AFM, g5, '2026-11-10');
  b = syncOk(w, '2026-11-16T09:00:20').mails.find(isBrief) || {};
  has(b.body, '  UserA  직전 취소 1건 · 사용 0건   [4주간 직전 취소 3건]', '10/19~11/15: 10/12 주는 빠짐');
  eq(w.table('주간보고').filter(r => r['예약자'] === 'UserA').map(r => r['이행률']).every(v => typeof v === 'number'), true, '「주간보고」 시트에는 이행률 그대로');
});

// ================================================================== 50
scenario('50', '예전 판이 남긴 기록: 같은 일정의 「예약」 행이 둘이어도 브리핑에 한 번, 「중복」 상태 행은 집계에서 뺌', () => {
  const ids = {};
  const w = boot();
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-12T10:00'); ids.g = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-13T15:00', '2026-10-13T18:00');
  syncOk(w, '2026-10-12T10:05');
  const s = w.sheet('예약기록');
  const g = lastRow(w, ids.g);
  const copy = s.cells[g._row - 1].map(v => (v && v.t === 'd' ? new Date(v.ms) : v));
  copy[s.cells[0].indexOf('비고')] = '사용 중 시간 수정';
  s.appendRow(copy);
  eq(w.rowsOf(ids.g).filter(r => r['상태'] === '예약').length, 2, '준비: 같은 일정 「예약」 두 행');
  // 이번 주 브리핑을 아직 안 보낸 것으로 두고 이번 주를 미리 봄
  const sent = w.props.get('briefingWeek');
  w.props.set('briefingWeek', String(kst('2026-10-05T09:00')));
  at(w, '2026-10-12T10:10'); const p = w.run('previewMondayMails'); runOk(p);
  w.props.set('briefingWeek', sent);
  hasNot(p.mails[0] && p.mails[0].body, '■ 중복 예약', '같은 일정은 중복 예약 아님');
  has(p.mails[0] && p.mails[0].body, '▶ ' + NAMES.AFM + ' (1건)', '장비별 건수도 한 번');
  // 운영 시트처럼 하나는 「중복」 상태 → 남은 예약을 사용 시작 뒤 지우면 직전 취소 하나, 집계에 「중복」 행 없음
  const dupRow = w.rowsOf(ids.g).find(r => r['비고'] === '사용 중 시간 수정')._row;
  s.getRange(dupRow, s.cells[0].indexOf('상태') + 1).setValue('중복');
  at(w, '2026-10-13T16:00'); w.calendar.remove(CAL.AFM, ids.g);
  const c = syncOk(w, '2026-10-13T16:05');
  eq(w.rowsOf(ids.g).map(r => [r['상태'], r['직전취소']]).sort(), [['중복', ''], ['취소', 'Y']], '직전 취소 한 건');
  eq(c.mails.filter(isCan).length, 1, '[예약취소] 한 통');
  const b = syncOk(w, '2026-10-19T09:00:20').mails.find(isBrief) || {};
  has(b.body, '  UserA  직전 취소 1건 · 사용 0건   [4주간 직전 취소 1건]', '집계에 「중복」 행 없음');
  has(b.htmlBody, 'max-width:560px', 'PC에서도 폭 제한');
});

// ================================================================== 51
scenario('51', '중복 예약 보기: 겹치는 시간, 순위, 시간 막대(겹치는 부분 빨강, 폭 합 100%)', () => {
  const w = boot();
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-12T10:00:03'); ev(w, CAL.AFM, 'UserB(Ag)', '2026-10-21T09:00', '2026-10-21T12:00');
  at(w, '2026-10-12T10:00:41'); ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-21T10:00', '2026-10-21T13:00');
  // 하루를 넘는 겹침(밤샘)
  at(w, '2026-10-12T10:01'); ev(w, CAL.TE1, 'UserF(Ag)', '2026-10-20T22:00', '2026-10-21T02:00');
  at(w, '2026-10-12T10:02'); ev(w, CAL.TE1, 'UserD', '2026-10-21T01:00', '2026-10-21T03:00');
  syncOk(w, '2026-10-12T10:05');
  const b = syncOk(w, '2026-10-19T09:00:20').mails.find(isBrief) || {};
  has(b.body, '  [LAB-A] Atomic Force Microscope  ·  10/21(수) 10:00–12:00 겹침', '같은 날: 날짜 한 번 + 겹치는 시간');
  has(b.body, '  1순위 UserB  09:00–12:00   [등록 10/12(월) 10:00:03]', '1순위: 시:분만, 등록 시각 오른쪽');
  has(b.body, '  2순위 UserA  10:00–13:00   [등록 10/12(월) 10:00:41]', '2순위');
  has(b.body, '[LAB-B] Thermal evaporator  ·  10/21(수) 01:00–02:00 겹침', '하루를 넘는 묶음은 날짜와 함께');
  has(b.body, '1순위 UserF  10/20(화) 22:00–10/21(수) 02:00', '하루를 넘는 예약 시간');
  const v = JSON.parse(w.eval('JSON.stringify(conflictGroups(Store.active()).map(g => { const v = conflictView_(g); return g.map(r => v.segments(r)); }))'));
  eq(v.map(g => g.map(s => Math.round(s.reduce((a, x) => a + x.w, 0) * 10) / 10)), [[100, 100], [100, 100]], '막대 폭 합 100%');
  eq(v[0].map(s => s.map(x => x.kind)), [['booked', 'overlap', 'track'], ['track', 'overlap', 'booked']], '1·2순위 막대: 겹치는 부분이 가운데에서 맞닿음');
  has(b.htmlBody, '1순위 <b>UserB</b>&nbsp; 09:00–12:00', 'HTML 줄');
  has(b.htmlBody, 'color:#b3261e;font-size:13px">10/21(수) 10:00–12:00 겹침</td>', 'HTML: 겹치는 시간 오른쪽 빨강');
});

// ================================================================== 52
scenario('52', '규칙 확인은 사람·날짜마다 한 항목: 그날 예약을 나열하고, 중복 예약에 걸린 건에 순위 표시', () => {
  const w = boot();
  at(w, '2026-10-18T18:00:03'); ev(w, CAL.TE1, 'UserB(Ag)', '2026-10-21T09:00', '2026-10-21T12:00');
  at(w, '2026-10-18T18:00:41'); ev(w, CAL.TE1, 'UserA (BCP)', '2026-10-21T10:00', '2026-10-21T13:00');
  at(w, '2026-10-18T18:01:10'); ev(w, CAL.TE1, 'UserA (BCP)', '2026-10-21T15:00', '2026-10-21T18:00');
  at(w, '2026-10-12T10:00'); ev(w, CAL.SPUT, 'UserE', '2026-10-22T09:00', '2026-10-22T12:00'); // 10/12에 다음 주를 잡음 = 기간전예약
  syncOk(w, '2026-10-12T10:05');
  syncOk(w, '2026-10-18T18:05');
  const b = syncOk(w, '2026-10-19T09:00:20').mails.find(isBrief) || {};
  has(b.body, '■ 규칙 확인 2건', '사람·날짜마다 한 항목(UserA 두 건은 하나로)');
  has(b.body, '  UserA  10/21(수) · 2건   [하루 1세션 초과]', '첫 줄: 날짜·건수, 오른쪽에 어긴 규칙');
  has(b.body, '    10:00–13:00  [LAB-B] Thermal evaporator   [중복 2순위]', '중복 예약에 걸린 건에 순위');
  has(b.body, '    15:00–18:00  [LAB-B] Thermal evaporator\n', '다른 건은 시간·장비만');
  has(b.body, '  UserE  10/22(목) 09:00–12:00   [기간전예약]\n    [LAB-B] Sputtering system', '한 건이면 시간과 규칙, 아래 줄 장비');
  has(b.body, '  2순위 UserA  10:00–13:00', '중복 예약 쪽 2순위와 같은 표기');
  has(b.htmlBody, '<b>UserA</b>&nbsp; 10/21(수) · 2건</td>', 'HTML 첫 줄');
  has(b.htmlBody, '10:00–13:00 · [LAB-B] Thermal evaporator</td><td align="right" valign="top" style="padding:0 0 0 12px;white-space:nowrap;color:#b3261e;font-size:13px">중복 2순위</td>',
    'HTML: 순위는 그 줄 오른쪽 끝');
});

// ================================================================== 53
scenario('53', '「주간보고」 시트를 지워도 월요일 브리핑은 나감(주간 기록만 건너뜀)', () => {
  const w = boot();
  syncOk(w, '2026-10-12T09:00:20');
  at(w, '2026-10-12T10:00'); const id = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-13T09:00', '2026-10-13T12:00');
  syncOk(w, '2026-10-12T10:05');
  at(w, '2026-10-13T09:30'); w.calendar.remove(CAL.AFM, id);
  syncOk(w, '2026-10-13T09:35');
  w.ss.deleteSheet(w.sheet('주간보고'));
  const e = syncOk(w, '2026-10-19T09:00:20');
  const b = e.mails.find(isBrief) || {};
  has(b.body, 'UserA  직전 취소 1건', '브리핑에 지난주 직전 취소');
  has(e.logs.join('\n'), '시트가 없어 주간 기록을 남기지 않았습니다', '로그');
});

// ================================================================== 54
scenario('54', '시트 탭 순서: 예약기록 · 주간보고 · 장비 · 사용자(그 밖의 탭은 뒤), 다시 실행해도 같음', () => {
  const w = boot();
  eq(w.ss.getSheets().map(s => s.getName()), ['예약기록', '주간보고', '장비', '사용자'], 'setup 뒤 순서');
  // 관리자가 순서를 섞고 백업 탭이 있는 상태에서 다시 맞춤
  w.ss.insertSheet('예약기록_백업');
  w.ss.sheets.reverse();
  runOk(w.run('arrangeSheetTabs'));
  eq(w.ss.getSheets().map(s => s.getName()), ['예약기록', '주간보고', '장비', '사용자', '예약기록_백업'], '다시 맞춤(백업은 뒤)');
  runOk(w.run('setup'));
  eq(w.ss.getSheets().map(s => s.getName()), ['예약기록', '주간보고', '장비', '사용자', '예약기록_백업'], 'setup 다시 실행해도 같음');
  at(w, '2026-10-12T10:00'); ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-13T09:00', '2026-10-13T12:00');
  syncOk(w, '2026-10-12T10:05');
  eq(w.rows().length, 1, '순서를 바꿔도 기록은 그대로');
});

// ================================================================== 56
scenario('56', '그룹 메일 맨 아래 안내(GROUP_FOOTER = notice): 시험용 그룹 견본, 기본은 그대로, 켜면 \'--\' 아래 작은 안내 + 그룹스 바닥글 숨김', () => {
  const w = boot();
  syncOk(w, '2026-10-12T09:00:20');
  const HIDE = '<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#ffffff;mso-hide:all">';
  const ROW = '<tr><td style="padding:0;font-family:Arial,sans-serif;font-size:11px;line-height:1.5;color:#80868b">';
  let e = w.run('testFooterMail'); runOk(e);
  eq(e.mails.length, 0, '시험 주소가 없으면 보내지 않음');
  has(e.logs.join('\n'), 'TEST_GROUP_EMAIL', '설정 안내');
  w.configOverrides = { TEST_GROUP_EMAIL: 'footer-test@example.com' };
  e = w.run('testFooterMail'); runOk(e);
  eq(e.mails.map(m => m.to), ['footer-test@example.com'], '시험용 그룹에만 한 통');
  const t = e.mails[0] || {};
  check(/^\[시험\] \[장비예약\]/.test(t.subject || '') && String(t.htmlBody).slice(-HIDE.length) === HIDE &&
    String(t.htmlBody).indexOf(ROW + '--</td></tr>' + ROW + 'You received this equipment booking notice because you are a member of the ') > 0 &&
    String(t.htmlBody).indexOf(ROW + 'To unsubscribe from this group, contact the group manager.</td></tr>') > 0,
    '견본: \'--\' 아래 작은 글씨를 한 줄씩 표 칸에 + 그룹스 바닥글 숨김 상자', String(t.htmlBody).slice(-900));
  check(/^<!DOCTYPE html><html><head>.*<meta name="viewport" content="width=device-width, initial-scale=1"><\/head><body /.test(t.htmlBody || ''), '휴대폰용 머리(viewport), body·html은 열어 둠', String(t.htmlBody).slice(0, 300));
  eq(/<\/body>|<\/html>/.test(t.htmlBody || ''), false, '그룹스 바닥글이 숨김 상자 안에 붙도록 닫지 않음');
  w.configOverrides = {};
  // 실제 그룹 메일: 기본(공개 설정 '')은 그대로, GROUP_FOOTER = notice면 [예약취소]·브리핑 끝에 안내 + 숨김 상자
  at(w, '2026-10-12T10:00'); const id = ev(w, CAL.AFM, 'UserA (BCP)', '2026-10-13T09:00', '2026-10-13T12:00');
  syncOk(w, '2026-10-12T10:05');
  at(w, '2026-10-13T09:30'); w.calendar.remove(CAL.AFM, id);
  let c = syncOk(w, '2026-10-13T09:35').mails.find(isCan) || {};
  eq(String(c.htmlBody).indexOf(HIDE) < 0, true, '기본은 그룹스 바닥글 그대로');
  w.configOverrides = { GROUP_FOOTER: 'notice' };
  at(w, '2026-10-13T10:00'); const id2 = ev(w, CAL.SPUT, 'UserI', '2026-10-13T13:00', '2026-10-13T16:00');
  syncOk(w, '2026-10-13T10:05');
  at(w, '2026-10-13T13:30'); w.calendar.remove(CAL.SPUT, id2);
  c = syncOk(w, '2026-10-13T13:35').mails.find(isCan) || {};
  eq(String(c.htmlBody).slice(-HIDE.length), HIDE, 'notice면 [예약취소] 끝에 안내 + 숨김 상자');
  const b = syncOk(w, '2026-10-19T09:00:20').mails.find(isBrief) || {};
  eq(String(b.htmlBody).slice(-HIDE.length), HIDE, '브리핑 끝에도');
  has(b.htmlBody, 'letter-spacing:-0.2px">10/19(월) 09:00~10/26(월) 09:00</div>', '본문 첫 줄은 기간만 촘촘하게(휴대폰 한 줄)');
  eq(b.subject, '[장비예약] 10/19(월)~10/26(월) 예약 내역', '메일 제목은 날짜만');
  // googlegroups 주소면 수신 거부 주소·그룹 페이지 링크, 그룹 이름
  const fakeGroup = ['example-lab-team', 'googlegroups.com'].join('@'); // 가상의 그룹 주소(googlegroups 형식 확인용)
  const notice = w.eval('groupFooterHtml_(' + JSON.stringify(fakeGroup) + ')');
  check(notice.indexOf('To unsubscribe from this group, send an email to <a href="mailto:' + encodeURIComponent(fakeGroup.split('@')[0] + '+unsubscribe') + '@' + fakeGroup.split('@')[1] + '"') > 0 &&
    notice.indexOf('Past messages are available on <a href="https://groups.google.com/g/example-lab-team"') > 0 &&
    notice.indexOf('You received this equipment booking notice because you are a member of the "Example Equipment Group" group.') > 0,
    '안내(영어 기본): 수신 거부 주소·지난 메일 링크·그룹 이름', notice);
  w.configOverrides = { FOOTER_LANG: 'ko' };
  syncOk(w, '2026-10-19T09:30');
  const ko = w.eval('groupFooterHtml_(' + JSON.stringify(fakeGroup) + ')');
  check(ko.indexOf('이 메일은 「Example Equipment Group」 그룹 회원에게 보내는 장비 예약 알림입니다.') > 0 &&
    ko.indexOf('이 그룹을 수신 거부하려면 <a href="mailto:') > 0 && ko.indexOf('>Google 그룹</a>에서 확인할 수 있습니다.') > 0,
    'FOOTER_LANG = ko면 한국어 안내', ko);
  w.configOverrides = {};
});

// ------------------------------------------------------------------ 요약
const all = results.flatMap(r => r.checks);
const failed = all.filter(c => !c.pass);
console.log('\n' + results.length + '개 시나리오, 검사 ' + all.length + '개, 실패 ' + failed.length + '개');
process.exitCode = failed.length ? 1 : 0;
