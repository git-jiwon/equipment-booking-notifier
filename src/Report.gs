/**
 * 월요일 09:00 브리핑 한 통(동기화 실행이 월 09:00이 지난 것을 보고 보낸다 — 09:00~09:05 사이)
 *   - 이번 주 예약: 중복 예약(캘린더 등록 순), 규칙 확인, 장비별 예약표
 *   - 지난주 직전 취소한 사람: 지난주 직전 취소·사용 건수와 4주간 직전 취소 건수(사람별 기록은 「주간보고」 시트에)
 * 보내기에 실패하면 다음 동기화에서 다시 보낸다.
 */
function maybeSendMondayMails_(hadErrors, runStart) {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  // 이 실행이 캘린더를 읽기 시작한 시각 기준: 09:00 전에 읽은 내용으로 브리핑을 만들지 않는다
  const ws = weekStartFor(runStart || now);
  // 캘린더 오류가 있으면 잠시 기다렸다가(빠진 기록 없이) 보낸다
  if (hadErrors && now < ws + CONFIG.BRIEFING_WAIT_MINUTES * 60 * 1000) return;

  // 보낸 주(또는 설치 때 건너뛰기로 한 주)보다 뒤인 주만
  const done = k => Number(props.getProperty(k) || 0);
  const last = ws - WEEK_MS;
  const needReport = done('reportWeek') < last;
  if (done('briefingWeek') >= ws) {
    if (needReport) props.setProperty('reportWeek', String(last));
    return;
  }
  const rep = needReport ? buildWeeklyReport_(last, now) : null;
  if (rep && done('reportSheetWeek') < last) {
    Store.appendWeekly(rep.sheetRows);
    props.setProperty('reportSheetWeek', String(last));
  }
  const b = buildBriefing_(ws, now, rep);
  if (!CONFIG.NOTIFY.MONDAY_BRIEFING || sendGroupMail_(b.subject, b.body, CONFIG.REPORT_CC, b.html)) {
    props.setProperty('briefingWeek', String(ws));
    if (needReport) props.setProperty('reportWeek', String(last));
  }
}

/**
 * 관리자에게만 미리보기: 다음에 나갈 월요일 브리핑. 이번 주 브리핑을 이미 보냈으면 다음 월요일 것을 지금까지의
 * 기록으로 만든다. 「지난주 직전 취소」는 실제 메일과 같은 조건(설치한 주·이미 보낸 주는 넣지 않음)일 때만 넣는다.
 * 그룹에는 보내지 않고 동기화도 하지 않음
 */
function previewMondayMails() {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  let ws = weekStartFor(now);
  if (Number(props.getProperty('briefingWeek') || 0) >= ws) ws += WEEK_MS;
  const last = ws - WEEK_MS;
  const withReport = Number(props.getProperty('reportWeek') || 0) < last; // maybeSendMondayMails_의 needReport와 같은 조건
  const b = buildBriefing_(ws, now, withReport ? buildWeeklyReport_(last, now) : null);
  sendAdminMail_('[미리보기] ' + b.subject, b.body, b.html);
  console.log('월요일 브리핑 미리보기를 관리자에게 요청했습니다.');
  logPersonalDetails_(b.subject + '\n' + b.body + (withReport ? '' :
    '\n\n(이 메일에는 「지난주 직전 취소」가 없습니다: ' + fmtKst(last) + ' 주는 설치한 주이거나 이미 보낸 주)'));
}

/** 장비 표시 이름(「장비」 시트의 현재 이름, 없으면 기록 당시 이름) */
function equipmentNames_() {
  const m = {};
  try { Store.equipments().forEach(e => { m[e.calendarId] = e.name; }); } catch (e) { /* 시트 없음 */ }
  return m;
}

const isOverlapFlag_ = v => v.indexOf('다른 예약과 시간 겹침') === 0;

/** 지금 기록 기준으로 다시 계산한 규칙 확인(겹침은 중복 예약 항목에서 따로 보여 준다) */
function ruleFlags_(rows) {
  const all = Store.active();
  const out = [];
  for (const r of rows) {
    const v = checkViolations(r, all, CONFIG).filter(x => !isOverlapFlag_(x));
    if (v.length) out.push({ r, v });
  }
  return out.sort((a, b) => a.r.start - b.r.start);
}

/** rep: 지난주 요약(buildWeeklyReport_) 또는 null. 일반 글과 HTML(회색 카드)을 함께 만든다 */
function buildBriefing_(ws, now, rep) {
  const we = ws + WEEK_MS;
  const names = equipmentNames_();
  const eqName = r => names[r.calendarId] || r.equipment;
  const week = Store.all().filter(r => r.start >= ws && r.start < we);
  const seen = new Set(); // 같은 일정의 기록이 둘 남아 있어도 한 번만(동기화 때 「중복」으로 정리된다)
  const active = week.filter(r => r.status === STATUS.ACTIVE && !seen.has(r.calendarId + '|' + r.eventId) &&
    seen.add(r.calendarId + '|' + r.eventId)).sort(byStart_);
  const groups = conflictGroups(active);
  const flags = ruleFlags_(active);
  const rules = ruleEntries_(flags, groups);
  const booked = active.filter(r => r.kind !== KIND.MAINTENANCE); // 장비별 건수에는 점검을 세지 않는다
  const cals = Array.from(new Set(booked.map(r => r.calendarId)))
    .sort((a, b) => String(names[a] || a).localeCompare(String(names[b] || b)));
  const title = fmtKst(ws) + ' ~ ' + fmtKst(we) + ' 예약 내역';

  // 일반 글
  const t = [title, ''];
  if (groups.length) {
    t.push('■ 중복 예약 ' + groups.length + '건');
    for (const g of groups) {
      const v = conflictView_(g);
      t.push('  ' + eqName(g[0]) + '  ·  ' + v.overlap);
      g.forEach((r, i) => t.push('  ' + (i + 1) + '순위 ' + r.booker + '  ' + v.time(r) + '   [등록 ' + fmtKstSec(r.created) + ']'));
    }
    t.push('');
  }
  if (rules.length) {
    t.push('■ 규칙 확인 ' + rules.length + '건');
    for (const x of rules) {
      if (x.rows.length === 1) {
        const y = x.rows[0];
        t.push('  ' + x.booker + '  ' + fmtSlot(y.r.start, y.r.end) + '   [' + x.labels.join(', ') + ']');
        t.push('    ' + eqName(y.r) + (y.tags.length ? '   [' + y.tags.join(', ') + ']' : ''));
      } else {
        t.push('  ' + x.booker + '  ' + x.dayLabel + ' · ' + x.rows.length + '건   [' + x.labels.join(', ') + ']');
        x.rows.forEach(y => t.push('    ' + x.time(y.r) + '  ' + eqName(y.r) + (y.tags.length ? '   [' + y.tags.join(', ') + ']' : '')));
      }
    }
    t.push('');
  }
  t.push('■ 장비별 예약');
  if (!cals.length) t.push('  이번 주 예약이 없습니다.');
  for (const cal of cals) {
    const n = booked.filter(r => r.calendarId === cal).length;
    t.push('▶ ' + (names[cal] || booked.find(r => r.calendarId === cal).equipment) + ' (' + n + '건)');
  }
  if (rep) {
    t.push('', '■ 지난주 직전 취소  (' + rep.summary + ')');
    if (!rep.people.length) t.push('  직전 취소 없음');
    rep.people.forEach((p, i) => {
      if (i) t.push('');
      t.push('  ' + p.booker + '  ' + p.week + '   [' + p.recent + ']');
      p.items.forEach(x => t.push('    ' + x.slot + ' ' + x.eq + '   [취소 ' + x.cancelled + ']'));
    });
  }
  t.push('', '예약기록 시트 열기: ' + SpreadsheetApp.getActive().getUrl());

  // HTML: 섹션마다 회색 카드, 항목은 굵은 첫 줄 + 회색 둘째 줄(휴대폰 폭에서 잘리지 않게)
  const e = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const item = (main, sub) => '<div style="padding:5px 0"><div>' + main + '</div>' +
    (sub ? '<div style="color:#6b7280;font-size:13px">' + sub + '</div>' : '') + '</div>';
  // 줄마다 오른쪽 끝에 따로 붙는 값이 있는 항목: 첫 줄(예: 4주간 직전 취소)과 회색 둘째 줄들(예: 취소 시각)
  const rightCell = (v, sub) => '<td align="right" valign="top" style="padding:0 0 0 12px;white-space:nowrap;' +
    (sub ? 'color:#6b7280;font-size:13px' : 'color:#374151') + '">' + v + '</td>';
  const rightItem = (main, right, subs) => '<div style="padding:5px 0"><table cellpadding="0" cellspacing="0" width="100%" ' +
    'style="border-collapse:collapse"><tr><td style="padding:0">' + main + '</td>' + rightCell(right) + '</tr>' +
    (subs || []).map(([l, r]) => '<tr><td style="padding:0;color:#6b7280;font-size:13px">' + l + '</td>' + rightCell(r, true) + '</tr>').join('') +
    '</table></div>';
  // right: 제목 줄 오른쪽에 붙는 회색 요약(예: 지난주 합계)
  const section = (head, inner, right) => (!right ? '<div style="margin:18px 0 6px 0;font-weight:bold">' + e(head) + '</div>' :
    '<table cellpadding="0" cellspacing="0" width="100%" style="margin:18px 0 6px 0;border-collapse:collapse"><tr>' +
    '<td style="font-weight:bold;padding:0">' + e(head) + '</td>' +
    '<td align="right" style="padding:0 0 0 12px;color:#6b7280;font-size:13px;white-space:nowrap">' + e(right) + '</td></tr></table>') +
    '<table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:separate;border:1px solid #e3e6ea;' +
    'border-radius:8px;background:#f8f9fb"><tr><td style="padding:8px 14px">' + inner + '</td></tr></table>';
  const h = ['<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.5;max-width:' +
    (CONFIG.MAIL_MAX_WIDTH || 560) + 'px">',
    '<div style="font-size:16px;font-weight:bold">' + e(title) + '</div>'];
  if (groups.length) {
    // 묶음마다: 장비 이름 + 오른쪽에 겹치는 시간(빨강), 사람마다 순위·시간 + 오른쪽 끝에 등록 시각, 아래에 시간 막대
    // (막대: 묶음 전체 시간 중 그 예약의 시간, 다른 예약과 겹치는 부분은 빨강)
    const BAR = { track: '#e5e7eb', booked: '#94a3b8', overlap: '#ef4444' };
    const bar = segs => '<table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin:4px 0 0 0"><tr>' +
      segs.map(s => '<td width="' + s.w + '%" style="height:6px;line-height:6px;font-size:0;padding:0;background:' + BAR[s.kind] +
        '">&nbsp;</td>').join('') + '</tr></table>';
    h.push(section('중복 예약 ' + groups.length + '건', groups.map((g, gi) => {
      const v = conflictView_(g);
      return '<table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin:' + (gi ? '14px' : '4px') +
        ' 0 2px 0"><tr><td style="font-weight:bold;padding:0">' + e(eqName(g[0])) + '</td>' +
        '<td align="right" valign="top" style="padding:0 0 0 12px;white-space:nowrap;color:#b3261e;font-size:13px">' + e(v.overlap) +
        '</td></tr></table>' +
        g.map((r, i) => '<div style="padding:5px 0 3px 0"><table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">' +
          '<tr><td style="padding:0">' + (i + 1) + '순위 <b>' + e(r.booker) + '</b>&nbsp; ' + e(v.time(r)) + '</td>' +
          '<td align="right" valign="top" style="padding:0 0 0 12px;white-space:nowrap;color:#6b7280;font-size:13px">등록 ' +
          e(fmtKstSec(r.created)) + '</td></tr></table>' + bar(v.segments(r)) + '</div>').join('');
    }).join('')));
  }
  if (flags.length) {
    // 사람·날짜마다 한 항목: 첫 줄 오른쪽 끝에 어긴 규칙(빨강), 아래 줄마다 그날 예약(시간·장비)과 오른쪽 끝에
    // 그 예약에만 해당하는 것(중복 예약 순위, 한 건에만 붙은 규칙)
    const redCell = v => '<td align="right" valign="top" style="padding:0 0 0 12px;white-space:nowrap;color:#b3261e;font-size:13px">' + v + '</td>';
    const greyRow = (l, tags) => '<tr><td style="padding:0;color:#6b7280;font-size:13px">' + l + '</td>' + redCell(e(tags.join(', '))) + '</tr>';
    h.push(section('규칙 확인 ' + rules.length + '건', rules.map(x => {
      const one = x.rows.length === 1;
      const head = one ? '<b>' + e(x.booker) + '</b>&nbsp; ' + e(fmtSlot(x.rows[0].r.start, x.rows[0].r.end)) :
        '<b>' + e(x.booker) + '</b>&nbsp; ' + e(x.dayLabel) + ' · ' + x.rows.length + '건';
      return '<div style="padding:5px 0"><table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">' +
        '<tr><td style="padding:0">' + head + '</td>' + redCell(e(x.labels.join(', '))) + '</tr>' +
        x.rows.map(y => greyRow((one ? '' : e(x.time(y.r)) + ' · ') + e(eqName(y.r)), y.tags)).join('') + '</table></div>';
    }).join('')));
  }
  h.push(section('장비별 예약', !cals.length ? item('이번 주 예약이 없습니다.') :
    '<table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">' + cals.map(cal => {
      const n = booked.filter(r => r.calendarId === cal).length;
      return '<tr><td style="padding:5px 12px 5px 0">' + e(names[cal] || booked.find(r => r.calendarId === cal).equipment) +
        '</td><td align="right" style="padding:5px 0;white-space:nowrap;color:#374151">' + n + '건</td></tr>';
    }).join('') + '</table>'));
  if (rep) {
    h.push(section('지난주 직전 취소',
      !rep.people.length ? item('직전 취소 없음') : rep.people.map(p =>
        rightItem('<b>' + e(p.booker) + '</b> · ' + e(p.week), e(p.recent),
          p.items.map(x => [e(x.slot) + ' · ' + e(x.eq), '취소 ' + e(x.cancelled)]))).join(''),
      rep.summary));
  }
  h.push('<p style="margin:18px 0 0 0"><a href="' + e(SpreadsheetApp.getActive().getUrl()) + '">예약기록 시트 열기</a></p></div>');

  return {
    subject: CONFIG.SUBJECT_PREFIX + ' ' + title,
    body: t.join('\n'),
    html: h.join('')
  };
}

/**
 * 지난주 요약(브리핑에 붙임): 지난주 직전 취소한 사람과, 그 사람의 최근 REPORT_LATE_WEEKS주(지난주까지) 직전 취소·사용
 * 건수. 사람별 전체 기록(이행률 포함)은 「주간보고」 시트 행으로. 이행률 = 사용 ÷ (사용 + 직전 취소).
 * 수업 예약·점검·양도는 세지 않는다.
 */
function buildWeeklyReport_(weekStart, now) {
  const weekEnd = weekStart + WEEK_MS;
  const names = equipmentNames_();
  const eqName = r => names[r.calendarId] || r.equipment;
  const rows = Store.all().filter(r => r.start >= weekStart && r.start < weekEnd);
  const pct = x => (x === null ? '-' : Math.round(x * 100) + '%');
  const sum = (list, f) => list.reduce((s, p) => s + f(p), 0);

  // 「사용자」 시트에서 나중에 묶은 표기도 한 사람으로 센다(지난 기록 포함)
  const aliases = Store.aliases();
  const canon = r => {
    const name = canonicalName(r.booker, aliases);
    return name === r.booker ? r : Object.assign({}, r, { booker: name, bookerKey: bookerKeyOf(name) });
  };
  const all = summarizeWeek(rows.map(canon), now);
  const used = sum(all, p => p.used.length);
  const late = sum(all, p => p.late);
  // 최근 몇 주(지난주 포함) 누적 직전 취소 건수
  const weeks = Math.max(1, CONFIG.REPORT_LATE_WEEKS || 4);
  const from = weekStart - (weeks - 1) * WEEK_MS;
  const span = new Map(summarizeWeek(Store.all().filter(r => r.start >= from && r.start < weekEnd).map(canon), now)
    .map(p => [p.bookerKey, p]));
  // 누적 직전 취소가 많은 순(같으면 지난주 직전 취소가 많은 순, 지난주 사용이 적은 순, 이름순)
  const people = all.filter(p => p.late)
    .map(p => {
      const s = span.get(p.bookerKey) || p;
      return {
        booker: p.booker, late: p.late, used: p.used.length, recentLate: s.late,
        week: '직전 취소 ' + p.late + '건 · 사용 ' + p.used.length + '건', // 지난주
        recent: weeks + '주간 직전 취소 ' + s.late + '건',                    // 오른쪽 끝에 따로
        items: p.cancelled.filter(r => r.late).sort(byStart_)
          .map(r => ({ slot: fmtSlot(r.start, r.end), eq: eqName(r), cancelled: fmtKst(r.cancelled) }))
      };
    })
    .sort((a, b) => b.recentLate - a.recentLate || b.late - a.late || a.used - b.used ||
      String(a.booker).localeCompare(String(b.booker)));

  const sheetRows = all.map(p => [new Date(weekStart), p.booker, p.used.length, p.normal + p.moved, p.late,
    p.rate === null ? '' : p.rate,
    p.used.map(r => fmtSlot(r.start, r.end) + ' ' + eqName(r)).join('\n'),
    p.cancelled.map(r => fmtSlot(r.start, r.end) + ' ' + eqName(r) + (r.late ? ' (직전 취소)' : '')).join('\n')]);
  return {
    summary: '직전 취소 ' + late + '건 · 사용 ' + used + '건',
    people, sheetRows, used, late
  };
}

const byStart_ = (a, b) => a.start - b.start;

/**
 * 규칙 확인 항목: 같은 사람·같은 사용일(09:00~09:00, 하루 제한을 장비별로 세면 같은 장비)의 위반 예약을 한 항목으로 묶는다.
 * labels: 첫 줄에 보일 규칙(묶음의 모든 예약에 붙은 것, 한 건이면 전부), rows[].tags: 그 예약에만 붙은 규칙과 중복 예약 순위.
 * dayLabel: 사용일 날짜, time(r): 그날 안이면 시:분만
 */
function ruleEntries_(flags, groups) {
  const key = r => r.calendarId + '|' + r.eventId;
  const rank = new Map();
  groups.forEach(g => g.forEach((r, i) => rank.set(key(r), i + 1)));
  const byKey = new Map();
  for (const f of flags) {
    const day = usageDayStart(f.r.start);
    const k = f.r.bookerKey + '|' + day + '|' + (CONFIG.DAY_LIMIT_SCOPE === 'ALL' ? '' : f.r.calendarId);
    if (!byKey.has(k)) byKey.set(k, { booker: f.r.booker, day, list: [] });
    byKey.get(k).list.push(f);
  }
  return Array.from(byKey.values()).map(x => {
    x.list.sort((a, b) => a.r.start - b.r.start);
    const all = [];
    x.list.forEach(f => f.v.forEach(l => { if (all.indexOf(l) < 0) all.push(l); }));
    const common = all.filter(l => x.list.every(f => f.v.indexOf(l) >= 0));
    const label = calendarDayStart(x.day); // 사용일(09:00 시작)의 달력 날짜
    return {
      booker: x.booker,
      dayLabel: fmtKst(x.day).slice(0, 8),
      labels: x.list.length === 1 ? all : common,
      time: r => (calendarDayStart(r.start) === label && calendarDayStart(r.end - 1) === label ?
        fmtSlot(r.start, r.end).slice(fmtKst(r.start).length - 5) : fmtSlot(r.start, r.end)),
      rows: x.list.map(f => ({
        r: f.r,
        tags: (x.list.length === 1 ? [] : f.v.filter(l => common.indexOf(l) < 0))
          .concat(rank.has(key(f.r)) ? ['중복 ' + rank.get(key(f.r)) + '순위'] : [])
      }))
    };
  }).sort((a, b) => a.rows[0].r.start - b.rows[0].r.start);
}

/**
 * 중복 예약 묶음 보기. overlap: 겹치는 시간(같은 날이면 '10/21(수) 10:00–12:00 겹침'),
 * time(r): 그 예약의 시간(묶음이 하루 안이면 시:분만), segments(r): 시간 막대 구간 [{ w: 폭 %, kind: track|booked|overlap }]
 */
function conflictView_(g) {
  const gs = Math.min.apply(null, g.map(r => r.start));
  const ge = Math.max.apply(null, g.map(r => r.end));
  const sameDay = calendarDayStart(gs) === calendarDayStart(ge - 1);
  const merge = list => list.slice().sort((a, b) => a[0] - b[0]).reduce((out, x) => {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]); else out.push(x.slice());
    return out;
  }, []);
  // 이 예약이 묶음의 다른 예약과 겹치는 구간들
  const overlapOf = r => merge(g.filter(o => o !== r && overlaps(o, r))
    .map(o => [Math.max(o.start, r.start), Math.min(o.end, r.end)]));
  const windows = merge([].concat.apply([], g.map(overlapOf)));
  const time = (s, e) => (sameDay ? fmtSlot(s, e).slice(fmtKst(s).length - 5) : fmtSlot(s, e));
  return {
    overlap: (sameDay ? fmtKst(gs).slice(0, 8) + ' ' : '') + windows.map(w => time(w[0], w[1])).join(', ') + ' 겹침',
    time: r => time(r.start, r.end),
    segments: r => {
      const ov = overlapOf(r);
      const pts = Array.from(new Set([gs, ge, r.start, r.end].concat([].concat.apply([], ov)))).sort((a, b) => a - b);
      const segs = [];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const mid = (a + b) / 2;
        const kind = mid < r.start || mid > r.end ? 'track' : ov.some(([x, y]) => mid > x && mid < y) ? 'overlap' : 'booked';
        const last = segs[segs.length - 1];
        if (last && last.kind === kind) last.len += b - a; else segs.push({ kind, len: b - a });
      }
      // 폭(%)은 소수 한 자리, 합이 100이 되게 마지막 칸에서 맞춘다
      let used = 0;
      return segs.map((s, i) => {
        const w = i === segs.length - 1 ? Math.round((100 - used) * 10) / 10 : Math.round(s.len / (ge - gs) * 1000) / 10;
        used += w;
        return { w, kind: s.kind };
      });
    }
  };
}
