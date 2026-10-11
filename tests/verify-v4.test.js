// 독립 재현(검증5 verify-correction): 3판(회귀 모형) → 고장 → 3판 되살림 → 4판 바로잡기 뒤 특정 행을 규칙으로 계산한 정답과 비교
// node tests/verify-v4.test.js [S1,S2,...]  환경: ORDER=newest|oldest, SRC=<4판 src 폴더(없으면 tests/lib가 읽는 src)>
// 이름은 익명(UserA, UserD, UserF, UserG, UserH, UserE)만.
'use strict';
process.env.TZ = 'Asia/Seoul';
const path = require('path');
const { World, kst } = require('./lib/gas-sim');
const V3 = path.join(__dirname, 'fixtures', 'src-v3'); // 이전 버전 회귀 모형
const V4 = process.env.SRC ? path.resolve(process.env.SRC) : null;

const C = {
  SPUT: 'example-sputter@group.calendar.google.com',
  TE1: 'example-thermal-1@group.calendar.google.com',
  AFM: 'example-afm@group.calendar.google.com'
};
const fmt = ms => (typeof ms === 'number' ? new Date(ms + 9 * 3600e3).toISOString().slice(5, 19).replace('T', ' ') : String(ms));

// 예전 20열 순서, H1(등록시각) 제목 칸이 빔
const OLD = ['장비', '캘린더ID', '일정ID', '예약자', '제목', '시작', '종료', '', '등록구분', '상태', '취소시각', '직전취소',
  '늦은취소기준', '위반', '만든계정', '비고', '순위시각', '마감시작', '마감종료', '판정사유'];
const MAP = { '': '등록시각', '늦은취소기준': '직전취소기준', '판정사유': '제외사유' };

function makeWorld() {
  const w = new World({ now: '2026-10-03T12:00' });
  w.srcDir = V3;
  w.calendar.addCalendar(C.SPUT, '[LAB-B] Sputtering system', { accessRole: 'writer' });
  w.calendar.addCalendar(C.TE1, '[LAB-B] Thermal evaporator', { accessRole: 'writer' });
  w.calendar.addCalendar(C.AFM, '[LAB-A] Atomic Force Microscope', { accessRole: 'writer' });
  w.run('setup'); w.run('fillEquipmentSheet'); w.run('initialSync');
  w.props.set('kindsVersion', '8');
  return w;
}

function cut(w, order) {
  const sh = w.sheet('예약기록');
  const hdr = sh.cells[0];
  let body = sh.cells.slice(1).map(row => OLD.map(h => {
    if (h === '순위시각') return '';
    const i = hdr.indexOf(MAP[h] || h);
    return i >= 0 && i < row.length ? row[i] : '';
  }));
  if (order === 'oldest') body = body.map((r, i) => ({ r, i })).sort((a, b) => ((a.r[7] && a.r[7].ms) || 0) - ((b.r[7] && b.r[7].ms) || 0) || b.i - a.i).map(x => x.r);
  const bk = w.ss.insertSheet('예약기록_백업');
  bk.cells = [OLD.slice()].concat(body);
  bk.textCols = new Set(['장비', '캘린더ID', '일정ID', '예약자', '제목', '등록구분', '상태', '직전취소', '위반', '만든계정', '비고', '판정사유'].map(h => OLD.indexOf(h) + 1));
  bk.protect();
  sh.cells.forEach((row, i) => { if (i > 0) row[0] = ''; });
  w.props.set('columnsVersion', '99'); // 고장 동안(예전 판처럼 등록시각 없이)
}

/** 장면: steps = [[시각, fn(w, ids)] ...]. 각 장면 뒤 5분 단위 동기화. 22:57 고장, 23:30 3판 되살림, 00:30 4판 */
function play(steps, order) {
  const w = makeWorld();
  const ids = {};
  const ev = (cal, summary, s, e) => w.calendar.create(cal, { summary, start: s, end: e });
  const plan = [];
  const syncs = new Set();
  for (const [t, fn] of steps) { plan.push({ t: kst(t), pr: 1, fn }); syncs.add(Math.floor(kst(t) / 300000) * 300000 + 300000); }
  const CUT = kst('2026-10-11T22:57'), RESTORE = kst('2026-10-11T23:30'), FIX = kst('2026-10-12T00:30');
  syncs.add(RESTORE);
  for (const t of syncs) if (t < FIX) plan.push({ t, pr: 2, sync: true });
  plan.push({ t: CUT, pr: 0, cut: true });
  plan.sort((a, b) => a.t - b.t || a.pr - b.pr);
  const errs = [];
  const run = t => { w.at(t); const e = w.run('syncAll'); if (e.error || e.errors.length) errs.push(fmt(t) + ' ' + (e.errorText || '') + e.errors.join(' | ')); return e; };
  let v3 = null;
  for (const p of plan) {
    if (p.cut) { w.at(p.t); cut(w, order); continue; }
    if (p.fn) { w.at(p.t); p.fn(w, ids, ev); continue; }
    if (p.t === RESTORE) w.props.set('columnsVersion', '2');
    const e = run(p.t);
    if (p.t === RESTORE) v3 = e;
  }
  const before = w.table('예약기록').map(r => Object.assign({}, r));
  w.srcDir = V4; // null = tests/lib가 읽는 src(이 사본의 src = 지금 프로젝트 src)
  const v4 = run(FIX);
  const monday = run(kst('2026-10-12T09:00:20'));
  return { w, ids, v3, v4, monday, before, errs };
}

const row = (w, id, pred) => w.table('예약기록').filter(r => r['일정ID'] === id && (!pred || pred(r)));
const show = r => r['상태'] + ' ' + r['예약자'] + ' ' + fmt(r['시작']) + ' 등록 ' + fmt(r['등록시각']) + ' ' + r['등록구분'] +
  ' 직전 ' + (r['직전취소'] || '-') + (r['제외사유'] ? '(' + r['제외사유'] + ')' : '') + (r['위반'] ? ' 위반 ' + r['위반'] : '');
const brief = R => ((R.monday.mails.find(m => /예약 내역$/.test(m.subject))) || {}).body || '';
const fixMail = R => ((R.v4.mails.find(m => /바로잡음/.test(m.subject))) || {}).body || '';

let fails = 0;
function expect(tag, ok, detail) { if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + tag + (ok ? '' : '\n      ' + String(detail).replace(/\n/g, '\n      '))); }

const SCENES = {
  // V4-1: 3판 동안 겹친 2순위가 지움(양보, 바르게 판정) → 1순위가 줄여 겹침이 사라짐
  S1: order => {
    const R = play([
      ['2026-10-11T10:30', (w, ids, ev) => { ids.H = ev(C.TE1, 'UserH', '2026-10-11T20:00', '2026-10-12T00:00'); }],
      ['2026-10-11T10:45', (w, ids, ev) => { ids.Y = ev(C.TE1, 'UserE', '2026-10-11T22:00', '2026-10-12T00:00'); }],
      ['2026-10-11T23:46', (w, ids) => w.calendar.remove(C.TE1, ids.Y)],
      ['2026-10-11T23:51', (w, ids) => w.calendar.patch(C.TE1, ids.H, { end: '2026-10-11T22:00' })]
    ], order);
    const before = R.before.find(r => r['일정ID'] === R.ids.Y && r['상태'] === '취소');
    const y = row(R.w, R.ids.Y, r => r['상태'] === '취소')[0];
    console.log('  S1 3판 직후: ' + show(before) + '\n  S1 4판 뒤:   ' + show(y));
    console.log('  메일: ' + fixMail(R).split('\n').filter(l => /\]: /.test(l)).join(' / '));
    expect('S1[' + order + '] UserE 취소는 지울 때 겹친 1순위(UserH 20–24)에 양보: N(양보)', y['직전취소'] === 'N' && y['제외사유'] === '양보', show(y));
    expect('S1[' + order + '] 브리핑에 UserE 직전 취소 없음', !/UserE\s+직전 취소/.test(brief(R)), brief(R).split('\n').filter(l => /UserE/.test(l)).join('\n'));
    return R;
  },
  // V4-1 반대: 3판 동안 겹치지 않는 예약 삭제(직전 취소) → 앞 예약이 그 시간까지 늘림
  S1b: order => {
    const R = play([
      ['2026-10-11T10:10', (w, ids, ev) => { ids.G = ev(C.SPUT, 'UserA', '2026-10-11T21:00', '2026-10-12T00:00'); }],
      ['2026-10-11T11:10', (w, ids, ev) => { ids.S = ev(C.SPUT, 'UserG', '2026-10-12T00:00', '2026-10-12T09:00'); }],
      ['2026-10-11T23:50', (w, ids) => w.calendar.remove(C.SPUT, ids.S)],
      ['2026-10-11T23:56', (w, ids) => w.calendar.patch(C.SPUT, ids.G, { end: '2026-10-12T09:00' })]
    ], order);
    const s = row(R.w, R.ids.S, r => r['상태'] === '취소')[0];
    console.log('  S1b 4판 뒤: ' + show(s));
    expect('S1b[' + order + '] UserG 취소는 지울 때 겹친 예약 없음: Y', s['직전취소'] === 'Y' && !s['제외사유'], show(s));
    return R;
  },
  // V4-2: 지웠다 되살린 예약(경쟁 백업 행) → 백업 뒤 'for class'
  S2: order => {
    const R = play([
      ['2026-10-11T18:01:10', (w, ids, ev) => { ids.G = ev(C.SPUT, 'UserA', '2026-10-14T09:00', '2026-10-14T12:00'); }],
      ['2026-10-11T18:20', (w, ids) => w.calendar.remove(C.SPUT, ids.G)],
      ['2026-10-11T18:30', (w, ids) => w.calendar.restore(C.SPUT, ids.G)],
      ['2026-10-11T18:40', (w, ids, ev) => { ids.G2 = ev(C.SPUT, 'UserA', '2026-10-14T15:00', '2026-10-14T18:00'); }],
      ['2026-10-11T23:44', (w, ids) => w.calendar.patch(C.SPUT, ids.G, { summary: 'UserA for class' })]
    ], order);
    const g = row(R.w, R.ids.G, r => r['상태'] === '예약')[0];
    const g2 = row(R.w, R.ids.G2)[0];
    console.log('  S2 4판 뒤: ' + show(g) + '\n             ' + show(g2));
    expect('S2[' + order + '] for class 행은 수업예약 그대로', g['등록구분'] === '수업예약', show(g));
    expect('S2[' + order + '] 하루 1세션 초과 표시 없음', !/하루/.test(g['위반'] + g2['위반']), show(g) + '\n' + show(g2));
    return R;
  },
  // V4-3: 수업 → 사람(백업 전) → 수업(백업 뒤): 사람 예약을 넘겨받은 수업 행은 그 사람의 등록시각
  S3: order => {
    const R = play([
      ['2026-10-11T19:10', (w, ids, ev) => { ids.C = ev(C.SPUT, 'UserE for class', '2026-10-16T09:00', '2026-10-16T12:00'); }],
      ['2026-10-11T19:20', (w, ids, ev) => { ids.M = ev(C.SPUT, 'UserD', '2026-10-16T10:00', '2026-10-16T13:00'); }],
      ['2026-10-11T20:10', (w, ids) => w.calendar.patch(C.SPUT, ids.C, { summary: 'UserH' })],
      ['2026-10-11T23:46:30', (w, ids) => w.calendar.patch(C.SPUT, ids.C, { summary: 'UserE for class' })]
    ], order);
    const c = row(R.w, R.ids.C, r => r['상태'] === '예약')[0];
    const cb = R.before.find(r => r['일정ID'] === R.ids.C && r['상태'] === '예약');
    console.log('  S3 3판 직후: ' + show(cb) + '\n  S3 4판 뒤:   ' + show(c));
    expect('S3[' + order + '] 수업 행 등록시각 = UserH 행(20:10, 넘겨받음)', fmt(c['등록시각']) === '10-11 20:10:00', show(c));
    const b = brief(R);
    expect('S3[' + order + '] 브리핑 중복 1순위 UserD', /1순위 UserD/.test(b), b.split('\n').filter(l => /순위/.test(l)).join('\n'));
    return R;
  },
  // V4-1 변형: 3판 동안 1순위가 지움(직전 취소, 바르게 판정) → 그 뒤 겹친 2순위가 시작 전에 [Fix]로 넘김(점검 행이 2순위의
  // 등록시각을 이어받아 as-of 판정의 그 시각 예약으로 보임). 시간은 바뀌지 않으므로 지금/백업 시간 비교로는 못 거른다
  S5: order => {
    const R = play([
      ['2026-10-11T10:00', (w, ids, ev) => { ids.S = ev(C.TE1, 'UserG', '2026-10-12T02:00', '2026-10-12T05:00'); }],
      ['2026-10-11T11:00', (w, ids, ev) => { ids.G = ev(C.TE1, 'UserA', '2026-10-12T01:00', '2026-10-12T04:00'); }],
      ['2026-10-11T23:40', (w, ids) => w.calendar.remove(C.TE1, ids.S)],
      ['2026-10-11T23:50', (w, ids) => w.calendar.patch(C.TE1, ids.G, { summary: '[Fix] Evaporator' })]
    ], order);
    const before = R.before.find(r => r['일정ID'] === R.ids.S && r['상태'] === '취소');
    const s = row(R.w, R.ids.S, r => r['상태'] === '취소')[0];
    console.log('  S5 3판 직후: ' + show(before) + '\n  S5 4판 뒤:   ' + show(s));
    R.w.table('예약기록').filter(r => r['일정ID'] === R.ids.G).forEach(r => console.log('             ' + show(r)));
    expect('S5[' + order + '] UserG(1순위) 취소 = Y (지울 때 점검 없음)', s['직전취소'] === 'Y' && !s['제외사유'], show(s));
    return R;
  },
  // V4-4: 옮겼다 되돌린 일정(백업 오래된 순) + 3판 동안 다른 사람 취소
  S4: order => {
    const R = play([
      ['2026-10-11T12:00', (w, ids, ev) => { ids.J = ev(C.TE1, 'UserF', '2026-10-11T21:00', '2026-10-12T00:00'); }],
      ['2026-10-11T12:30', (w, ids) => w.calendar.patch(C.TE1, ids.J, { start: '2026-10-11T18:00', end: '2026-10-11T21:00' })],
      ['2026-10-11T12:45', (w, ids, ev) => { ids.M = ev(C.TE1, 'UserD', '2026-10-11T21:00', '2026-10-12T00:00'); }],
      ['2026-10-11T13:00', (w, ids) => w.calendar.patch(C.TE1, ids.J, { start: '2026-10-11T21:00', end: '2026-10-12T00:00' })],
      ['2026-10-11T23:40', (w, ids) => w.calendar.remove(C.TE1, ids.M)]
    ], order);
    const j = row(R.w, R.ids.J, r => r['상태'] === '예약')[0];
    const m = row(R.w, R.ids.M, r => r['상태'] === '취소')[0];
    console.log('  S4 4판 뒤: ' + show(j) + '\n             ' + show(m));
    expect('S4[' + order + '] UserF 예약 등록 13:00', fmt(j['등록시각']) === '10-11 13:00:00', show(j));
    expect('S4[' + order + '] UserD(1순위) 취소 = Y', m['직전취소'] === 'Y' && !m['제외사유'], show(m));
    return R;
  }
};

const pick = process.argv[2] ? process.argv[2].split(',') : Object.keys(SCENES);
const orders = process.env.ORDER ? [process.env.ORDER] : ['newest', 'oldest'];
for (const s of pick) for (const o of orders) {
  const R = SCENES[s](o);
  if (R.errs.length) { fails++; console.log('FAIL ' + s + ' 실행 오류: ' + R.errs.join('\n')); }
}
console.log('\n실패 ' + fails);
process.exitCode = fails ? 1 : 0;
