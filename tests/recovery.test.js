// node tests/recovery.test.js — 등록시각 되살리기(restoreFromBackup / restoreCreated_ / correctRestore_) 차이 검사
// 합성 회귀 시나리오: 제목 칸이 비어 있는 예전 시트의 열 이동 중 등록시각을 잃은 상황을 재현한다.
// 같은 캘린더 이력을 두 세계에서 돌린다: T(고장 없음, 정답) / B(일 23:00에 등록시각을 잃고, 백업에서 되살림).
// 되살린 뒤의 행·월요일 브리핑이 T와 같은지 본다. [3판 뒤 바로잡기]는 이전 버전 복구 모형(tests/fixtures/src-v3)이
// 먼저 되살린 뒤 지금 판이 백업과 다시 대조해 바로잡는 경우. 이름은 익명(UserA, UserD, UserF, UserG, UserH, UserE)만.
'use strict';
process.env.TZ = process.env.TZ || 'Asia/Seoul';
const path = require('path');
const { World, mapStack, kst } = require('./lib/gas-sim');
const V3_SRC = path.join(__dirname, 'fixtures', 'src-v3');

const CAL = {
  AFM: 'example-afm@group.calendar.google.com',
  SPUT: 'example-sputter@group.calendar.google.com',
  TE1: 'example-thermal-1@group.calendar.google.com',
  TE2: 'example-thermal-2@group.calendar.google.com'
};
const NAMES = {
  AFM: '[LAB-A] Atomic Force Microscope', SPUT: '[LAB-B] Sputtering system',
  TE1: '[LAB-B] Thermal evaporator', TE2: '[LAB-B] Thermal evaporator'
};
const fmt = ms => (ms ? new Date(ms + 9 * 3600e3).toISOString().slice(5, 19).replace('T', ' ') : String(ms));

let failures = 0;
const out = [];
function check(pass, label, detail) {
  if (!pass) failures++;
  out.push((pass ? 'ok   ' : 'FAIL ') + label + (!pass && detail ? '\n        ' + String(detail).replace(/\n/g, '\n        ') : ''));
  return pass;
}
function runOk(e, label) {
  return check(!e.error && e.errors.length === 0, (label || e.fn) + ' @' + fmt(e.at) + ' 오류 없음', (e.errorText || '') + e.errors.join('\n'));
}

// ------------------------------------------------------------------ 이력
const USER_OLD_HDR = ['장비', '캘린더ID', '일정ID', '예약자', '제목', '시작', '종료', '', '등록구분', '상태', '취소시각', '직전취소',
  '늦은취소기준', '위반', '만든계정', '비고', '순위시각', '마감시작', '마감종료', '판정사유'];
const OLD_TEXT_HDR = ['장비', '캘린더ID', '일정ID', '예약자', '제목', '등록구분', '상태', '직전취소', '위반', '만든계정', '비고', '판정사유'];
const toUserOldLayout = sh => {
  const hdr = sh.cells[0].slice();
  const idx = h => hdr.indexOf(h === '' ? '등록시각' : h === '늦은취소기준' ? '직전취소기준' : h === '판정사유' ? '제외사유' : h);
  return sh.cells.map((row, r) => USER_OLD_HDR.map(h => (r === 0 ? h : h === '순위시각' ? '' : idx(h) >= 0 && idx(h) < row.length ? row[idx(h)] : '')));
};

/**
 * opts.broken: true면 CUT 시각에 등록시각을 잃는다(백업 + A열 비움), RESTORE 시각에 새 코드로 되살림
 * opts.backupOrder: 'newest'(지금 시트 순서 그대로) | 'oldest'(등록시각 오름차순 = 예전 판의 추가 순서)
 * opts.pad26: 백업을 26열로(U..Z 빈 제목, W열에 떠도는 값)
 * opts.second: 「예약기록_백업2」도 만든다(같은 내용, 몇 행 빠짐)
 */
function play(opts) {
  opts = opts || {};
  const ids = {};
  const w = new World({ now: '2026-10-03T12:00' });
  for (const k of Object.keys(CAL)) w.calendar.addCalendar(CAL[k], NAMES[k], { accessRole: 'writer' });
  const at = t => w.at(t);
  const ev = (cal, summary, s, e, extra) => w.calendar.create(cal, Object.assign({ summary, start: s, end: e }, extra || {}));
  const sync = t => { at(t); const e = w.run('syncAll'); if (!opts.quiet) runOk(e, (opts.label || '') + ' syncAll'); return e; };
  w.run('setup'); w.run('fillEquipmentSheet'); w.run('initialSync');

  // ---- 지난주(10-05 주)
  at('2026-10-04T18:30'); ids.m1 = ev(CAL.TE2, 'UserD', '2026-10-08T09:00', '2026-10-08T12:00');
  sync('2026-10-04T18:35');
  sync('2026-10-05T09:00:20');
  at('2026-10-05T10:00'); w.calendar.patch(CAL.TE2, ids.m1, { start: '2026-10-09T09:00', end: '2026-10-09T12:00' }); // 옮김(직전 취소)
  sync('2026-10-05T10:05');
  at('2026-10-05T11:00'); w.calendar.patch(CAL.TE2, ids.m1, { start: '2026-10-08T09:00', end: '2026-10-08T12:00' }); // 되돌림
  sync('2026-10-05T11:05');
  at('2026-10-05T12:00'); ids.h1 = ev(CAL.SPUT, 'UserH', '2026-10-07T15:00', '2026-10-07T18:00');
  sync('2026-10-05T12:05');
  at('2026-10-07T15:30'); w.calendar.remove(CAL.SPUT, ids.h1);        // 사용 시작 뒤 삭제 = 직전 취소
  sync('2026-10-07T15:35');
  at('2026-10-07T16:00'); w.calendar.restore(CAL.SPUT, ids.h1);       // 되살림 = 다시 등록(같은 시작)
  sync('2026-10-07T16:05');
  at('2026-10-06T10:00');
  ids.j0 = ev(CAL.AFM, 'UserF(AFM)', '2026-10-11T21:00', '2026-10-12T00:00');   // 일 21~24 추가예약
  at('2026-10-08T10:00'); ids.g3 = ev(CAL.TE2, 'UserA (BCP)', '2026-10-11T21:00', '2026-10-12T00:00');
  at('2026-10-09T10:00'); ids.s3 = ev(CAL.TE2, 'UserG', '2026-10-11T22:00', '2026-10-12T00:00'); // 겹침 2순위
  sync('2026-10-09T10:05');

  // ---- 이번 주(10-12 주)
  at('2026-10-10T09:00'); ids.s1 = ev(CAL.SPUT, 'UserG', '2026-10-13T09:00', '2026-10-13T12:00');   // 기간전예약
  at('2026-10-10T10:00'); ids.y1 = ev(CAL.SPUT, 'UserE', '2026-10-15T09:00', '2026-10-15T12:00');    // 기간전예약
  sync('2026-10-10T10:05');
  at('2026-10-11T18:00:03'); ids.j1 = ev(CAL.TE1, 'UserF(Ag)', '2026-10-13T09:00', '2026-10-13T12:00');
  at('2026-10-11T18:00:41'); ids.m2 = ev(CAL.TE1, 'UserD', '2026-10-13T10:00', '2026-10-13T13:00');
  at('2026-10-11T18:01:10'); ids.g1 = ev(CAL.AFM, 'UserA (BCP)', '2026-10-14T09:00', '2026-10-14T12:00');
  at('2026-10-11T18:01:30'); ids.g2 = ev(CAL.AFM, 'UserA (BCP)', '2026-10-14T15:00', '2026-10-14T18:00');
  at('2026-10-11T18:02'); ids.j3 = ev(CAL.TE2, 'UserF(Ag)', '2026-10-13T09:00', '2026-10-13T12:00');
  at('2026-10-11T18:05'); ids.h3 = ev(CAL.TE2, 'UserH', '2026-10-13T10:00', '2026-10-13T12:00');      // UserF 뒤 2순위
  at('2026-10-11T18:20'); ids.h4 = ev(CAL.TE2, 'UserH', '2026-10-14T09:00', '2026-10-14T12:00');
  at('2026-10-11T19:00'); ids.c1 = ev(CAL.SPUT, 'UserC for class', '2026-10-16T09:00', '2026-10-16T12:00');
  at('2026-10-11T20:00'); ids.fx = ev(CAL.TE2, '[Fix] Evaporator', '2026-10-14T09:00', '2026-10-14T18:00');
  at('2026-10-11T20:30'); ids.h2 = ev(CAL.SPUT, 'UserH', '2026-10-16T10:00', '2026-10-16T13:00');
  sync('2026-10-11T20:35');
  at('2026-10-11T21:00'); w.calendar.patch(CAL.SPUT, ids.s1, { start: '2026-10-14T13:00', end: '2026-10-14T16:00' }); // 시간 변경(새 행)
  sync('2026-10-11T21:05');
  at('2026-10-11T22:00'); w.calendar.patch(CAL.SPUT, ids.c1, { summary: 'UserA' });   // 수업 → 사람: 넘겨받은 시각 등록
  sync('2026-10-11T22:05');
  at('2026-10-11T18:10'); ids.rec = w.calendar.createRecurring(CAL.AFM, { summary: 'UserG(AFM)', start: '2026-10-16T15:00', end: '2026-10-16T18:00' },
    ['2026-10-16T15:00', '2026-10-23T15:00', '2026-10-30T15:00']);
  at('2026-10-11T18:12'); ids.y5 = ev(CAL.AFM, 'UserE(AFM)', '2026-10-23T16:00', '2026-10-23T18:00'); // 다음 주 회차와 겹침(기간전)
  at('2026-10-11T22:58'); ids.m4 = ev(CAL.TE1, 'UserD', '2026-10-11T23:00', '2026-10-12T00:00'); // 등록 직후
  sync('2026-10-11T22:59');

  // ---- 23:00 고장: 예전 판이 열을 옮기며 등록시각을 비움(백업은 예전 열 순서·빈 H1)
  if (opts.broken) {
    const s = w.sheet('예약기록');
    const bk = w.ss.insertSheet('예약기록_백업');
    let cells = toUserOldLayout(s);
    if (opts.backupOrder === 'oldest') {
      const H = cells[0];
      const ci = 7;
      const body = cells.slice(1).map((r, i) => ({ r, i })).sort((a, b) => {
        const x = a.r[ci] && a.r[ci].ms || 0, y = b.r[ci] && b.r[ci].ms || 0;
        return x - y || b.i - a.i; // 같은 등록시각이면 (최신순 시트의 아래 = 먼저 생긴 행) 먼저
      }).map(x => x.r);
      cells = [H].concat(body);
    }
    if (opts.pad26) {
      cells = cells.map((r, i) => r.concat(['', '', i === 3 ? 'memo' : '', '', '', '']));
    }
    if (opts.strDates) {
      const ds = v => new Date(v.ms + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
      cells = cells.map((r, i) => (i === 0 ? r : r.map(v => (v && typeof v === 'object' && v.t === 'd' ? ds(v) : v))));
    }
    bk.cells = cells;
    bk.textCols = new Set(OLD_TEXT_HDR.map(h => USER_OLD_HDR.indexOf(h) + 1));
    bk.protect();
    if (opts.second) {
      const b2 = w.ss.insertSheet('예약기록_백업2');
      b2.cells = cells.filter((r, i) => i === 0 || i % 3);
      b2.textCols = new Set(bk.textCols);
    }
    s.cells.forEach((row, i) => { if (i > 0) row[0] = ''; });
    w.props.set('columnsVersion', '99'); // 고장 난 동안: 되살리기 없이 그대로 돈다(예전 판처럼 등록시각 없이)
  }

  // ---- 고장 난 동안(일 23:00 ~ 23:55)에 생긴 일
  at('2026-10-11T23:05'); w.calendar.remove(CAL.TE1, ids.m4);         // 등록 7분 뒤 삭제 = 유예
  at('2026-10-11T23:10'); w.calendar.remove(CAL.AFM, ids.j0);         // 사용 중 삭제 = 직전 취소
  sync('2026-10-11T23:12');
  at('2026-10-11T23:15'); w.calendar.remove(CAL.TE2, ids.s3);         // 2순위 삭제 = 양보
  sync('2026-10-11T23:17');
  at('2026-10-11T23:20'); ids.fx2 = ev(CAL.AFM, '[Fix] AFM tip', '2026-10-11T21:00', '2026-10-12T00:00'); // 지운 뒤 생긴 점검
  at('2026-10-11T23:25'); w.calendar.remove(CAL.TE2, ids.g3);         // 1순위도 나중에 지움
  sync('2026-10-11T23:27');
  at('2026-10-11T23:30'); w.calendar.patch(CAL.SPUT, ids.s1, { start: '2026-10-14T14:00', end: '2026-10-14T17:00' }); // 겹치게 조정
  at('2026-10-11T23:35'); w.calendar.patch(CAL.SPUT, ids.c1, { summary: 'UserE' }); // 사람 → 사람 양도(등록시각 이어받음)
  sync('2026-10-11T23:37');
  at('2026-10-11T23:31'); w.calendar.patch(CAL.AFM, ids.rec[0], { start: '2026-10-16T16:00', end: '2026-10-16T19:00' }); // 반복 회차 시간 조정
  // 반복 일정 「이 일정 및 이후 일정」 수정: 이후 회차는 새 ID(새 반복)로 다시 생긴다
  at('2026-10-11T23:42'); ids.rec.slice(1).forEach(id => w.calendar.remove(CAL.AFM, id));
  ids.rec2 = w.calendar.createRecurring(CAL.AFM, { summary: 'UserG(AFM)', start: '2026-10-23T15:00', end: '2026-10-23T18:00' },
    ['2026-10-23T15:00', '2026-10-30T15:00']);
  // 같은 예약을 지우고 다시 만듦(같은 동기화 안): 일정ID가 바뀌고 기록은 이어 간다
  at('2026-10-11T23:40'); w.calendar.remove(CAL.TE2, ids.h3);
  at('2026-10-11T23:41'); ids.h3b = ev(CAL.TE2, 'UserH', '2026-10-13T10:00', '2026-10-13T12:00');
  sync('2026-10-11T23:45');

  // ---- 새 코드 배포 후 첫 동기화(되살리기). v3First: 3판이 먼저 되살리고, 00:30에 지금 판을 배포해 바로잡음
  if (opts.broken && !opts.restoreAtMonday) w.props.set('columnsVersion', '2');
  if (opts.v3First) w.srcDir = V3_SRC;
  const restore = sync('2026-10-11T23:55');
  w.srcDir = null;
  const correct = sync('2026-10-12T00:30');
  if (opts.broken && opts.restoreAtMonday) w.props.set('columnsVersion', '2');
  const monday = sync('2026-10-12T09:00:20');
  return { w, ids, restore, correct, monday };
}

// 행 비교(일정ID·시작·상태·취소시각·예약자로 맞춤)
const FIELDS = ['등록시각', '등록구분', '직전취소', '제외사유', '위반', '마감시작', '마감종료', '직전취소기준'];
function rowsByKey(w) {
  const m = new Map();
  for (const r of w.table('예약기록')) {
    if (!r['일정ID']) continue;
    let k = [r['일정ID'], fmt(r['시작']), r['상태'], fmt(r['취소시각']), r['예약자']].join(' | ');
    if (m.has(k)) k += ' #2';
    m.set(k, r);
  }
  return m;
}
function diffWorlds(T, B, tag) {
  const a = rowsByKey(T.w), b = rowsByKey(B.w);
  const d = [];
  for (const [k, r] of a) {
    const x = b.get(k);
    if (!x) { d.push('없음: ' + k); continue; }
    for (const f of FIELDS) {
      const u = typeof r[f] === 'number' ? fmt(r[f]) : r[f];
      const v = typeof x[f] === 'number' ? fmt(x[f]) : x[f];
      if (String(u) !== String(v)) d.push(k + '  ' + f + ': 정답 ' + JSON.stringify(u) + ' / 되살림 ' + JSON.stringify(v));
    }
  }
  for (const k of b.keys()) if (!a.has(k)) d.push('더 있음: ' + k);
  check(!d.length, tag + ' 되살린 행이 정답과 같음', d.join('\n'));
  const brief = W => (W.monday.mails.find(m => /예약 내역$/.test(m.subject)) || {}).body || '(브리핑 없음)';
  const bt = brief(T), bb = brief(B);
  check(bt === bb, tag + ' 월요일 브리핑이 정답과 같음', '--- 정답\n' + bt + '\n--- 되살림\n' + bb);
  return { d, bt, bb };
}

// ------------------------------------------------------------------ 실행
const T = play({ label: 'T' });
for (const variant of [
  { tag: '[newest]', backupOrder: 'newest' },
  { tag: '[oldest]', backupOrder: 'oldest' },
  { tag: '[26열+백업2]', backupOrder: 'newest', pad26: true, second: true },
  { tag: '[글자 날짜]', backupOrder: 'oldest', strDates: true },
  { tag: '[월 09:00에 되살림]', backupOrder: 'newest', restoreAtMonday: true },
  { tag: '[3판 뒤 바로잡기 newest]', backupOrder: 'newest', v3First: true },
  { tag: '[3판 뒤 바로잡기 oldest]', backupOrder: 'oldest', v3First: true }
]) {
  const B = play(Object.assign({ broken: true, label: variant.tag }, variant));
  const r = diffWorlds(T, B, variant.tag);
  const restoreLog = B.restore.logs.join('\n');
  out.push('  log: ' + restoreLog.split('\n').filter(l => /되살렸/.test(l)).join(' / '));
  check(B.restore.mails.length === 0, variant.tag + ' 되살리는 동기화에 메일 없음', B.restore.mails.map(m => m.subject).join('\n'));
  if (variant.v3First) {
    const fixLog = B.correct.logs.join('\n');
    out.push('  바로잡기 log: ' + fixLog.split('\n').filter(l => /바로잡았|\]:/.test(l)).join('\n    '));
    check(B.correct.mails.every(m => /예약기록 바로잡음/.test(m.subject) && !/googlegroups/.test(m.to)), variant.tag + ' 바로잡기 메일은 관리자에게만',
      B.correct.mails.map(m => m.to + ' ' + m.subject).join('\n'));
    check(B.w.props.get('columnsVersion') === '4', variant.tag + ' 한 번만(4)', B.w.props.get('columnsVersion'));
  }
  // 빨간색: 직전취소 Y 행과 규칙 범위
  const sh = B.w.sheet('예약기록');
  const rule = sh.cfRules.find(x => /^=\$[A-Z]+2="Y"$/.test(x.formula || ''));
  const col = rule ? rule.formula.charCodeAt(2) - 64 : -1;
  check(rule && sh.cells[0][col - 1] === '직전취소' && rule.ranges[0].row === 2 && rule.ranges[0].row + rule.ranges[0].nr - 1 >= sh.getLastRow(),
    variant.tag + ' 빨간색 규칙이 직전취소 열·모든 행', JSON.stringify(rule && { f: rule.formula, r: rule.ranges }));
  if (process.env.SHOW) { console.log('=== ' + variant.tag + ' 정답 브리핑\n' + r.bt + '\n=== 되살림 브리핑\n' + r.bb); }
}
console.log(out.join('\n'));
console.log('\n실패 ' + failures);
process.exitCode = failures ? 1 : 0;
