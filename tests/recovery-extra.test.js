// node tests/recovery-extra.test.js — 3판 → 4판 바로잡기(correctRestore_) 확장 차이 검사(검증5에서 가져옴)
// 알려진 한계(KNOWN)는 정답과 다를 수 있으나 관리자 메일에 그 행이 나와야 한다(조용히 바꾸거나 넘어가지 않음).
// T(고장 없음, 같은 판 교체 시각) / B(22:57에 등록시각을 잃고 23:30에 3판이 되살리고, v4 시각에 지금 판이 바로잡음)
// 이름은 익명(UserA, UserD, UserF, UserG, UserH, UserE)만. 주소는 example.com.
// 환경: EP=E1,E2 (에피소드만), V3=real|fixture, ORDER=newest|oldest, V4AT=0030|0900, SHOW=1
'use strict';
process.env.TZ = process.env.TZ || 'Asia/Seoul';
const path = require('path');
const { World, kst } = require('./lib/gas-sim');
const V3_FIX = path.join(__dirname, 'fixtures', 'src-v3');
const V3_REAL = V3_FIX; // tests/fixtures/src-v3는 운영 3판 모형(9단계 중복 정리 없음)

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

const USER_OLD_HDR = ['장비', '캘린더ID', '일정ID', '예약자', '제목', '시작', '종료', '', '등록구분', '상태', '취소시각', '직전취소',
  '늦은취소기준', '위반', '만든계정', '비고', '순위시각', '마감시작', '마감종료', '판정사유'];
const OLD_TEXT_HDR = ['장비', '캘린더ID', '일정ID', '예약자', '제목', '등록구분', '상태', '직전취소', '위반', '만든계정', '비고', '판정사유'];
const toUserOldLayout = sh => {
  const hdr = sh.cells[0].slice();
  const idx = h => hdr.indexOf(h === '' ? '등록시각' : h === '늦은취소기준' ? '직전취소기준' : h === '판정사유' ? '제외사유' : h);
  return sh.cells.map((row, r) => USER_OLD_HDR.map(h => (r === 0 ? h : h === '순위시각' ? '' : idx(h) >= 0 && idx(h) < row.length ? row[idx(h)] : '')));
};

// ------------------------------------------------------------------ 에피소드(같은 행동을 두 세계에서)
// act(t, fn(x)) — x: { w, ids, ev, cal, broken }
const EPISODES = {
  // E1: 옮겼다 되돌린 일정(3판 짝 오류) + 그 순위에 걸린 다른 사람의 직전 취소(4판 한 바퀴 판정 순서)
  E1: act => {
    act('2026-10-11T12:00', x => { x.ids.J2 = x.ev(CAL.TE1, 'UserF(Ag)', '2026-10-11T21:00', '2026-10-12T00:00'); });
    act('2026-10-11T12:30', x => x.w.calendar.patch(CAL.TE1, x.ids.J2, { start: '2026-10-11T18:00', end: '2026-10-11T21:00' }));
    act('2026-10-11T12:45', x => { x.ids.M2 = x.ev(CAL.TE1, 'UserD', '2026-10-11T21:00', '2026-10-12T00:00'); });
    act('2026-10-11T13:00', x => x.w.calendar.patch(CAL.TE1, x.ids.J2, { start: '2026-10-11T21:00', end: '2026-10-12T00:00' }));
    act('2026-10-11T23:40', x => x.w.calendar.remove(CAL.TE1, x.ids.M2)); // 3판 동안: 1순위 UserD가 사용 중 삭제 = 직전 취소
  },
  // E2a: 고장 동안 2순위가 아닌 예약 삭제 → 그 뒤 앞 사람이 빈 시간으로 늘림(as-of 판정이 지금 시간을 씀)
  E2a: act => {
    act('2026-10-11T10:00', x => { x.ids.G2 = x.ev(CAL.TE2, 'UserA (BCP)', '2026-10-11T21:00', '2026-10-11T22:00'); });
    act('2026-10-11T11:00', x => { x.ids.S2 = x.ev(CAL.TE2, 'UserG', '2026-10-11T22:00', '2026-10-12T00:00'); });
    act('2026-10-11T23:10', x => x.w.calendar.remove(CAL.TE2, x.ids.S2));
    act('2026-10-11T23:14', x => x.w.calendar.patch(CAL.TE2, x.ids.G2, { end: '2026-10-12T00:00' }));
  },
  // E2: 3판 동안(바르게 판정됨) 일요일 밤 세션 삭제 → 앞 사람이 그 세션까지 늘림
  E2: act => {
    act('2026-10-11T10:10', x => { x.ids.G2b = x.ev(CAL.SPUT, 'UserA (BCP)', '2026-10-11T21:00', '2026-10-12T00:00'); });
    act('2026-10-11T11:10', x => { x.ids.S2b = x.ev(CAL.SPUT, 'UserG', '2026-10-12T00:00', '2026-10-12T09:00'); });
    act('2026-10-11T23:50', x => x.w.calendar.remove(CAL.SPUT, x.ids.S2b));
    act('2026-10-11T23:52', x => x.w.calendar.patch(CAL.SPUT, x.ids.G2b, { end: '2026-10-12T09:00' }));
  },
  // E2b: 3판 동안 겹친 2순위가 양보로 삭제 → 그 뒤 1순위가 시간을 줄임(겹침이 사라짐)
  E2b: act => {
    act('2026-10-11T10:30', x => { x.ids.H2 = x.ev(CAL.AFM, 'UserH', '2026-10-11T20:00', '2026-10-12T00:00'); });
    act('2026-10-11T10:45', x => { x.ids.Y2 = x.ev(CAL.AFM, 'UserE(AFM)', '2026-10-11T22:00', '2026-10-12T00:00'); });
    act('2026-10-11T23:46', x => x.w.calendar.remove(CAL.AFM, x.ids.Y2));
    act('2026-10-11T23:48', x => x.w.calendar.patch(CAL.AFM, x.ids.H2, { end: '2026-10-11T22:00' }));
  },
  // E3: 지웠다 되살린 예약(경쟁 백업 행) → 백업 뒤 'for class'로 바꿈(같은 행, 수업예약)
  E3: act => {
    act('2026-10-11T18:01:10', x => { x.ids.G3 = x.ev(CAL.SPUT, 'UserA', '2026-10-14T09:00', '2026-10-14T12:00'); });
    act('2026-10-11T18:20', x => x.w.calendar.remove(CAL.SPUT, x.ids.G3));
    act('2026-10-11T18:30', x => x.w.calendar.restore(CAL.SPUT, x.ids.G3));
    act('2026-10-11T18:40', x => { x.ids.G4 = x.ev(CAL.SPUT, 'UserA', '2026-10-14T15:00', '2026-10-14T18:00'); });
    act('2026-10-11T23:44', x => x.w.calendar.patch(CAL.SPUT, x.ids.G3, { summary: 'UserA for class' }));
  },
  // E4: [Fix] → 사람(백업 전) → [Fix](백업 뒤)
  E4: act => {
    act('2026-10-11T19:00', x => { x.ids.F4 = x.ev(CAL.TE2, '[Fix] Evaporator', '2026-10-15T09:00', '2026-10-15T18:00'); });
    act('2026-10-11T19:30', x => { x.ids.J4 = x.ev(CAL.TE2, 'UserF(Ag)', '2026-10-15T12:00', '2026-10-15T15:00'); });
    act('2026-10-11T20:00', x => x.w.calendar.patch(CAL.TE2, x.ids.F4, { summary: 'UserH' }));
    act('2026-10-11T23:45', x => x.w.calendar.patch(CAL.TE2, x.ids.F4, { summary: '[Fix] Evaporator' }));
  },
  // E4b: 수업 → 사람(백업 전) → 수업(백업 뒤), 겹친 UserD와 순위
  E4b: act => {
    act('2026-10-11T19:10', x => { x.ids.C4 = x.ev(CAL.SPUT, 'UserE for class', '2026-10-16T09:00', '2026-10-16T12:00'); });
    act('2026-10-11T19:20', x => { x.ids.M4 = x.ev(CAL.SPUT, 'UserD', '2026-10-16T10:00', '2026-10-16T13:00'); });
    act('2026-10-11T20:10', x => x.w.calendar.patch(CAL.SPUT, x.ids.C4, { summary: 'UserH' }));
    act('2026-10-11T23:46:30', x => x.w.calendar.patch(CAL.SPUT, x.ids.C4, { summary: 'UserE for class' }));
  },
  // E5: 사용 시작 뒤 삭제 + 되살림(백업 전) + 다시 삭제(고장 동안), 관리자가 두 취소 행의 직전취소를 N으로 고침(3판 뒤)
  E5: act => {
    act('2026-10-05T12:00', x => { x.ids.H5 = x.ev(CAL.SPUT, 'UserH', '2026-10-07T15:00', '2026-10-07T18:00'); });
    act('2026-10-07T15:30', x => x.w.calendar.remove(CAL.SPUT, x.ids.H5));
    act('2026-10-07T16:00', x => x.w.calendar.restore(CAL.SPUT, x.ids.H5));
    act('2026-10-11T23:16', x => x.w.calendar.remove(CAL.SPUT, x.ids.H5));
    act('2026-10-12T00:10', x => { x.adminLate(x.ids.H5, '2026-10-07T15:30', 'N'); x.adminLate(x.ids.H5, '2026-10-11T23:16', 'N'); }, { nosync: true });
  },
  // E5c: 관리자 수동 수정만(경쟁 백업 행 있는 백업 전 취소 행)
  E5c: act => {
    act('2026-10-05T12:10', x => { x.ids.H5c = x.ev(CAL.TE1, 'UserH', '2026-10-08T15:00', '2026-10-08T18:00'); });
    act('2026-10-08T15:30', x => x.w.calendar.remove(CAL.TE1, x.ids.H5c));
    act('2026-10-08T16:00', x => x.w.calendar.restore(CAL.TE1, x.ids.H5c));
    act('2026-10-12T00:11', x => x.adminLate(x.ids.H5c, '2026-10-08T15:30', 'N'), { nosync: true });
  },
  // E6: 실제 시트처럼 같은 [Fix] 일정의 세 행(양도 1 + 같은 시간·같은 등록시각 「예약」 2), kindsVersion 8 → 9
  E6: act => {
    act('2026-10-10T12:00', x => { x.ids.F6 = x.ev(CAL.AFM, '[Fix] AFM tip', '2026-10-10T13:00', '2026-10-11T12:00'); });
    act('2026-10-10T15:00', x => x.w.calendar.patch(CAL.AFM, x.ids.F6, { summary: 'AFM tip-in progress' }));
    act('2026-10-10T16:00', x => x.injectFix3(x.ids.F6), { nosync: true });
    act('2026-10-10T18:00', x => { x.ids.J6 = x.ev(CAL.AFM, 'UserF(AFM)', '2026-10-11T09:00', '2026-10-11T12:00'); });
    act('2026-10-11T23:20', x => x.w.calendar.remove(CAL.AFM, x.ids.J6)); // 고장 동안: 점검에 양보
  },
  // E8: 양도 사슬 UserA → UserD(백업 전) → UserF(고장 동안) → UserA(3판 동안), 겹친 UserH
  E8: act => {
    act('2026-10-11T18:02', x => { x.ids.T8 = x.ev(CAL.SPUT, 'UserA (BCP)', '2026-10-15T09:00', '2026-10-15T12:00'); });
    act('2026-10-11T18:03', x => { x.ids.H8 = x.ev(CAL.SPUT, 'UserH', '2026-10-15T10:00', '2026-10-15T13:00'); });
    act('2026-10-11T20:30', x => x.w.calendar.patch(CAL.SPUT, x.ids.T8, { summary: 'UserD' }));
    act('2026-10-11T23:12', x => x.w.calendar.patch(CAL.SPUT, x.ids.T8, { summary: 'UserF(Ag)' }));
    act('2026-10-11T23:50:30', x => x.w.calendar.patch(CAL.SPUT, x.ids.T8, { summary: 'UserA (BCP)' }));
  },
  // E9: 한 일정을 백업 앞뒤로 여러 번 옮김, 겹친 UserG은 3판 동안 삭제
  E9: act => {
    act('2026-10-11T18:03:30', x => { x.ids.Y9 = x.ev(CAL.TE2, 'UserE', '2026-10-13T15:00', '2026-10-13T18:00'); });
    act('2026-10-11T18:40', x => x.w.calendar.patch(CAL.TE2, x.ids.Y9, { start: '2026-10-14T15:00', end: '2026-10-14T18:00' }));
    act('2026-10-11T19:01', x => { x.ids.S9 = x.ev(CAL.TE2, 'UserG', '2026-10-13T16:00', '2026-10-13T18:00'); });
    act('2026-10-11T19:40', x => x.w.calendar.patch(CAL.TE2, x.ids.Y9, { start: '2026-10-13T15:00', end: '2026-10-13T18:00' }));
    act('2026-10-11T23:13', x => x.w.calendar.patch(CAL.TE2, x.ids.Y9, { start: '2026-10-16T15:00', end: '2026-10-16T18:00' }));
    act('2026-10-11T23:53', x => x.w.calendar.patch(CAL.TE2, x.ids.Y9, { start: '2026-10-13T15:00', end: '2026-10-13T18:00' }));
    act('2026-10-12T00:15', x => x.w.calendar.remove(CAL.TE2, x.ids.S9));
  },
  // E10: 3판 동안 새 예약이 되살린 행과 겹침
  E10: act => {
    act('2026-10-11T18:00:03', x => { x.ids.J10 = x.ev(CAL.TE1, 'UserF(Ag)', '2026-10-13T09:00', '2026-10-13T12:00'); });
    act('2026-10-11T18:00:41', x => { x.ids.M10 = x.ev(CAL.TE1, 'UserD', '2026-10-13T10:00', '2026-10-13T13:00'); });
    act('2026-10-12T00:05', x => { x.ids.H10 = x.ev(CAL.TE1, 'UserH', '2026-10-13T09:00', '2026-10-13T12:00'); });
  },
  // E11: 반복 일정, 고장 동안 하루 채우기(horizon)가 백업 뒤에 새 회차를 기록(등록시각은 시리즈 등록시각)
  E11: act => {
    act('2026-10-11T18:10', x => {
      x.ids.R11 = x.w.calendar.createRecurring(CAL.AFM, { summary: 'UserG(AFM)', start: '2026-10-18T21:00', end: '2026-10-19T00:00' },
        ['2026-10-18T21:00', '2026-10-25T21:00', '2026-11-01T21:00', '2026-11-08T21:00']);
    });
    act('2026-10-11T23:21', x => x.w.props.delete('horizonDay'));
  }
};

// ------------------------------------------------------------------ 한 세계 실행
function play(opts) {
  const eps = opts.episodes;
  const ids = {};
  const v3Src = opts.v3 === 'fixture' ? V3_FIX : V3_REAL;
  const w = new World({ now: '2026-10-03T12:00' });
  w.srcDir = v3Src; // 처음부터 운영에 있던 판(3판 모형)으로 돈다 — T도 같은 시각에 판을 바꾼다
  for (const k of Object.keys(CAL)) w.calendar.addCalendar(CAL[k], NAMES[k], { accessRole: 'writer' });
  const ev = (cal, summary, s, e, extra) => w.calendar.create(cal, Object.assign({ summary, start: s, end: e }, extra || {}));
  const execs = [];
  const sync = t => { w.at(t); const e = w.run('syncAll'); execs.push(e); return e; };
  w.run('setup'); w.run('fillEquipmentSheet'); w.run('initialSync');
  if (opts.v3 !== 'fixture') w.props.set('kindsVersion', '8');

  const sheetCol = (sh, h) => sh.cells[0].indexOf(h) + 1;
  const x = {
    w, ids, ev, broken: !!opts.broken,
    adminLate(eventId, cancelledAt, value) {
      const sh = w.sheet('예약기록');
      const t = kst(cancelledAt);
      let n = 0;
      for (const r of w.table('예약기록')) {
        if (r['일정ID'] !== eventId || r['취소시각'] !== t) continue;
        sh.getRange(r._row, sheetCol(sh, '직전취소')).setValue(value);
        n++;
      }
      if (n !== 1) throw new Error('adminLate: ' + eventId + ' ' + cancelledAt + ' 행 ' + n);
    },
    injectFix3(eventId) {
      const sh = w.sheet('예약기록');
      const hdr = sh.cells[0];
      const a = w.table('예약기록').find(r => r['일정ID'] === eventId);
      const memoAt = new Date(kst('2026-10-10T15:00'));
      sh.getRange(a._row, sheetCol(sh, '상태')).setValue('양도');
      sh.getRange(a._row, sheetCol(sh, '취소시각')).setValue(memoAt);
      sh.getRange(a._row, sheetCol(sh, '비고')).setValue('양도 → AFM tip-in progress');
      const base = {
        등록시각: new Date(a['등록시각']), 예약자: '점검', 장비: a['장비'], 시작: new Date(a['시작']), 종료: new Date(a['종료']),
        등록구분: '점검', 상태: '예약', 직전취소기준: new Date(a['직전취소기준']), 제목: 'AFM tip-in progress',
        캘린더ID: a['캘린더ID'], 일정ID: a['일정ID'], 만든계정: a['만든계정']
      };
      const r2 = Object.assign({}, base, { 비고: '양도 ← 점검 10/10(토) 15:00 / 사용 시작 뒤 제목 변경은 메모: 예약자 점검(으)로 바로잡음' });
      const r3 = Object.assign({}, base, { 비고: '양도 ← 점검 10/10(토) 15:00' });
      for (const o of [r2, r3]) sh.appendRow(hdr.map(h => (o[h] === undefined ? '' : o[h])));
      w.props.set('kindsVersion', '8');
    }
  };

  // 단계 모으기
  const steps = [];
  const syncAt = new Set();
  const next5 = ms => Math.floor(ms / 300000) * 300000 + 300000;
  for (const name of eps) {
    EPISODES[name]((t, fn, o) => {
      steps.push({ t: kst(t), pr: 1, fn });
      if (!(o && o.nosync)) syncAt.add(next5(kst(t)));
    });
  }
  const CUT = kst(opts.cutAt || '2026-10-11T22:57');
  const V3 = kst('2026-10-11T23:30');
  const V4 = kst(opts.v4At === '0900' ? '2026-10-12T09:00:20' : '2026-10-12T00:30');
  const MON = kst('2026-10-12T09:00:20');
  [kst('2026-10-04T18:35'), kst('2026-10-05T09:00:20'), V3, V4, MON, kst('2026-10-12T09:05'), kst('2026-10-12T09:10'),
    kst('2026-10-12T12:00'), kst('2026-10-13T09:05')].forEach(t => syncAt.add(t));
  for (const t of syncAt) if (t !== V4 && t !== MON) steps.push({ t, pr: 2, sync: true });
  steps.push({ t: CUT, pr: 0, cut: true });
  steps.push({ t: V4, pr: 3, v4: true });
  if (V4 !== MON) steps.push({ t: MON, pr: 4, mon: true });
  steps.sort((a, b) => a.t - b.t || a.pr - b.pr);

  const res = { w, ids, execs };
  for (const s of steps) {
    if (s.cut) {
      if (!opts.broken) continue;
      w.at(s.t);
      const sh = w.sheet('예약기록');
      const bk = w.ss.insertSheet('예약기록_백업');
      let cells = toUserOldLayout(sh);
      if (opts.order === 'oldest') {
        const body = cells.slice(1).map((r, i) => ({ r, i })).sort((a, b) => {
          const p = a.r[7] && a.r[7].ms || 0, q = b.r[7] && b.r[7].ms || 0;
          return p - q || b.i - a.i;
        }).map(z => z.r);
        cells = [cells[0]].concat(body);
      }
      bk.cells = cells;
      bk.textCols = new Set(OLD_TEXT_HDR.map(h => USER_OLD_HDR.indexOf(h) + 1));
      bk.protect();
      sh.cells.forEach((row, i) => { if (i > 0) row[0] = ''; });
      res.cutColumnsVersion = w.props.get('columnsVersion');
      w.props.set('columnsVersion', '99');
      continue;
    }
    if (s.fn) { w.at(s.t); s.fn(x); continue; }
    if (s.t === V3 && opts.broken) w.props.set('columnsVersion', '2');
    if (s.v4) {
      w.srcDir = null;
      res.beforeV4 = snapshot(w);
      res.v4 = sync(s.t);
      res.afterV4 = snapshot(w);
      if (s.t === MON) res.monday = res.v4;
      continue;
    }
    if (s.mon) { res.monday = sync(s.t); continue; }
    const e = sync(s.t);
    if (s.t === V3) res.v3 = e;
  }
  return res;
}

// ------------------------------------------------------------------ 비교
const FIELDS = ['등록시각', '등록구분', '직전취소', '제외사유', '위반', '마감시작', '마감종료', '직전취소기준'];
function rowsByKey(w) {
  const m = new Map();
  for (const r of w.table('예약기록')) {
    if (!r['일정ID']) continue;
    let k = [r['일정ID'], r['장비'].slice(-6), fmt(r['시작']), r['상태'], fmt(r['취소시각']), r['예약자']].join(' | ');
    while (m.has(k)) k += ' #2';
    m.set(k, r);
  }
  return m;
}
function snapshot(w) {
  const m = new Map();
  for (const [k, r] of rowsByKey(w)) m.set(k, Object.assign({}, r));
  return m;
}
const val = v => (typeof v === 'number' ? fmt(v) : String(v));
function diffRows(T, B) {
  const a = rowsByKey(T.w), b = rowsByKey(B.w);
  const d = [];
  for (const [k, r] of a) {
    const x = b.get(k);
    if (!x) { d.push('없음: ' + k); continue; }
    const nv = (f, v) => (f === '위반' ? String(v).split(' / ').sort().join(' / ') : val(v)); // 위반 문구 순서는 시트 순서를 따름(검사에서 무시)
    for (const f of FIELDS) if (nv(f, r[f]) !== nv(f, x[f])) d.push(k + '  ' + f + ': 정답 ' + JSON.stringify(val(r[f])) + ' / B ' + JSON.stringify(val(x[f])));
  }
  for (const k of b.keys()) if (!a.has(k)) d.push('더 있음: ' + k);
  return d;
}
const briefOf = R => ((R.monday && R.monday.mails.find(m => /예약 내역$/.test(m.subject))) || {}).body || '(브리핑 없음)';
function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const out = [];
  for (const l of A) if (B.indexOf(l) < 0) out.push('- ' + l);
  for (const l of B) if (A.indexOf(l) < 0) out.push('+ ' + l);
  return out.join('\n');
}

let failures = 0;
const out = [];
function check(pass, label, detail) {
  if (!pass) failures++;
  out.push((pass ? 'ok   ' : 'FAIL ') + label + (!pass && detail ? '\n        ' + String(detail).replace(/\n/g, '\n        ') : ''));
  return pass;
}

function runVariant(tag, opts) {
  const T = play(Object.assign({}, opts, { broken: false }));
  const B = play(Object.assign({}, opts, { broken: true }));
  const errs = W => W.execs.filter(e => e.error || e.errors.length).map(e => fmt(e.at) + ' ' + (e.errorText || '') + e.errors.join(' | '));
  check(!errs(T).length && !errs(B).length, tag + ' 실행 오류 없음', errs(T).concat(errs(B)).join('\n'));
  const d = diffRows(T, B);
  check(!d.length, tag + ' 행이 정답과 같음', d.join('\n'));
  const bt = briefOf(T), bb = briefOf(B);
  check(bt === bb, tag + ' 월요일 브리핑이 정답과 같음', lineDiff(bt, bb));
  // 바로잡기 메일: 관리자에게만, 바뀐 행만
  const fixMails = B.v4.mails.filter(m => /예약기록 바로잡음/.test(m.subject));
  const group = B.v4.mails.filter(m => /googlegroups/.test(m.to + ',' + (m.cc || '')));
  const groupT = T.v4.mails.filter(m => /googlegroups/.test(m.to + ',' + (m.cc || '')));
  check(fixMails.every(m => !/googlegroups/.test(m.to + ',' + (m.cc || ''))), tag + ' 바로잡음 메일은 관리자에게만', fixMails.map(m => m.to).join('\n'));
  check(JSON.stringify(group.map(m => m.subject).sort()) === JSON.stringify(groupT.map(m => m.subject).sort()),
    tag + ' v4 실행의 그룹 메일이 T와 같음', 'T: ' + groupT.map(m => m.subject).join(' / ') + '\nB: ' + group.map(m => m.subject).join(' / '));
  const changed = [];
  for (const [k, a] of B.beforeV4) {
    const b = B.afterV4.get(k);
    if (!b) continue;
    const f = ['등록시각', '등록구분', '직전취소', '제외사유'].filter(h => val(a[h]) !== val(b[h]));
    if (f.length) changed.push(k + ' :: ' + f.map(h => h + ' ' + val(a[h]) + '→' + val(b[h])).join(', '));
  }
  const body = fixMails.length ? fixMails[0].body : '';
  const lines = body.split('확인 필요')[0].split('\n').filter(l => /\]: /.test(l)); // 「확인 필요(바꾸지 않음)」 줄은 빼고 센다
  check(lines.length === changed.length, tag + ' 메일 줄 수 = 바뀐 행 수 (' + lines.length + ' / ' + changed.length + ')',
    '메일:\n' + lines.join('\n') + '\n시트:\n' + changed.join('\n'));
  // 다시 돌지 않음
  const later = B.execs.filter(e => e.at > B.v4.at);
  check(later.every(e => !e.mails.some(m => /바로잡음/.test(m.subject)) && !e.logs.some(l => /다시 대조/.test(l))), tag + ' 뒤 동기화에서 바로잡기 반복 없음');
  check(B.w.props.get('columnsVersion') === '4' && B.w.props.get('kindsVersion') === '9', tag + ' columnsVersion 4 · kindsVersion 9',
    B.w.props.get('columnsVersion') + ' / ' + B.w.props.get('kindsVersion'));
  if (process.env.SHOW) {
    out.push('  [B v4 log] ' + B.v4.logs.join('\n    '));
    out.push('  [v3 log] ' + (B.v3 ? B.v3.logs.join('\n    ') : ''));
  }
  return { T, B, d, lines, changed };
}

// 알려진 한계: E2a 고장 난 동안 앞 순위 예약의 시간까지 바뀜 → 바꾸지 않고 「확인 필요」로 알림,
//             E5·E5c 백업 뒤 관리자가 손으로 고친 직전취소 → 백업 기준 값으로 바뀌고 메일에 나옴
const KNOWN = ['E2a', 'E5', 'E5c'];
const ALL = Object.keys(EPISODES).filter(e => KNOWN.indexOf(e) < 0);
const pick = process.env.EP ? process.env.EP.split(',') : null;
const orders = process.env.ORDER ? [process.env.ORDER] : ['newest', 'oldest'];
const v3s = process.env.V3 ? [process.env.V3] : ['real'];
const v4s = process.env.V4AT ? [process.env.V4AT] : ['0030', '0900'];
const sets = pick ? [pick] : (process.env.SOLO ? ALL.map(e => [e]) : [ALL]);
for (const eps of sets) for (const v3 of v3s) for (const order of orders) for (const v4At of v4s) {
  const tag = '[' + eps.join('+') + ' v3=' + v3 + ' ' + order + ' v4@' + v4At + ']';
  runVariant(tag, { episodes: eps, v3, order, v4At });
}
if (!pick) {
  for (const ep of KNOWN) for (const order of orders) {
    const opts = { episodes: [ep], v3: 'real', order, v4At: '0030' };
    const T = play(Object.assign({}, opts, { broken: false }));
    const B = play(Object.assign({}, opts, { broken: true }));
    const mail = ((B.v4.mails.find(m => /예약기록 바로잡음/.test(m.subject))) || {}).body || '';
    const d = diffRows(T, B);
    // diff 줄: '일정ID | 장비 | 시작 | 상태 | 취소시각 | 예약자  칸: …' → 예약자 이름이 메일 줄 첫머리에 있어야 한다
    const who = l => ((/\|\s*([^|]+?)\s{2}\S[^|]*$/.exec(l) || [])[1] || '').trim();
    const missing = d.filter(l => !who(l) || mail.split('\n').every(m => m.indexOf(who(l) + '  ') !== 0));
    check(!missing.length, '[알려진 한계 ' + ep + ' ' + order + '] 정답과 다른 행은 관리자 메일에 나옴', missing.join('\n') + '\n--- 메일\n' + mail);
    if (ep === 'E2a') check(/확인 필요\(바꾸지 않음\):/.test(mail), '[알려진 한계 E2a ' + order + '] 「확인 필요」로 알림', mail);
  }
}
console.log(out.join('\n'));
console.log('\n실패 ' + failures);
process.exitCode = failures ? 1 : 0;
