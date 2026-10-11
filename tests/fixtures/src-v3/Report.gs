/**
 * 월요일 09:00 브리핑 한 통(동기화 실행이 월 09:00이 지난 것을 보고 보낸다 — 09:00~09:05 사이)
 *   - 이번 주 예약: 중복 예약(캘린더 등록 순), 규칙 확인, 장비별 예약표
 *   - 지난주 직전 취소한 사람과 그 사람의 4주간 직전 취소·사용 건수(사람별 기록은 「주간보고」 시트에)
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
 * 관리자에게만 미리보기: 다음에 나갈 월요일 브리핑(그 앞 주 직전 취소 포함). 이번 주 브리핑을 이미 보냈으면
 * 다음 월요일 것을 지금까지의 기록으로 만든다. 그룹에는 보내지 않고 동기화도 하지 않음
 */
function previewMondayMails() {
  const now = Date.now();
  let ws = weekStartFor(now);
  if (Number(PropertiesService.getScriptProperties().getProperty('briefingWeek') || 0) >= ws) ws += WEEK_MS;
  const b = buildBriefing_(ws, now, buildWeeklyReport_(ws - WEEK_MS, now));
  sendAdminMail_('[미리보기] ' + b.subject, b.body, b.html);
  console.log(b.subject + '\n' + b.body);
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
  const booked = active.filter(r => r.kind !== KIND.MAINTENANCE); // 장비별 건수에는 점검을 세지 않는다
  const cals = Array.from(new Set(booked.map(r => r.calendarId)))
    .sort((a, b) => String(names[a] || a).localeCompare(String(names[b] || b)));
  const title = fmtKst(ws) + ' ~ ' + fmtKst(we) + ' 예약 내역';

  // 일반 글
  const t = [title, ''];
  if (groups.length) {
    t.push('■ 중복 예약 ' + groups.length + '건');
    for (const g of groups) {
      t.push('  ' + eqName(g[0]));
      g.forEach((r, i) => t.push('  ' + (i + 1) + '. ' + r.booker + '  ' + fmtSlot(r.start, r.end) + '  (등록 ' + fmtKstSec(r.created) + ')'));
    }
    t.push('');
  }
  if (flags.length) {
    t.push('■ 규칙 확인 ' + flags.length + '건');
    for (const { r, v } of flags) t.push('  ' + r.booker + '  ' + fmtSlot(r.start, r.end) + '  ' + eqName(r) + ': ' + v.join(', '));
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
      t.push('  ' + p.booker + '  ' + p.recent);
      p.items.forEach(x => t.push('    ' + x.slot + ' ' + x.eq + ' (' + x.cancelled + ' 취소)'));
    });
  }
  t.push('', '예약기록 시트 열기: ' + SpreadsheetApp.getActive().getUrl());

  // HTML: 섹션마다 회색 카드, 항목은 굵은 첫 줄 + 회색 둘째 줄(휴대폰 폭에서 잘리지 않게)
  const e = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const item = (main, sub) => '<div style="padding:5px 0"><div>' + main + '</div>' +
    (sub ? '<div style="color:#6b7280;font-size:13px">' + sub + '</div>' : '') + '</div>';
  const section = (head, inner) => '<div style="margin:18px 0 6px 0;font-weight:bold">' + e(head) + '</div>' +
    '<table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:separate;border:1px solid #e3e6ea;' +
    'border-radius:8px;background:#f8f9fb"><tr><td style="padding:8px 14px">' + inner + '</td></tr></table>';
  const h = ['<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.5;max-width:' +
    (CONFIG.MAIL_MAX_WIDTH || 560) + 'px">',
    '<div style="font-size:16px;font-weight:bold">' + e(title) + '</div>'];
  if (groups.length) {
    h.push(section('중복 예약 ' + groups.length + '건', groups.map((g, gi) =>
      '<div style="font-weight:bold;padding:' + (gi ? '10px' : '4px') + ' 0 2px 0">' + e(eqName(g[0])) + '</div>' +
      g.map((r, i) => item((i + 1) + '. <b>' + e(r.booker) + '</b>  ' + e(fmtSlot(r.start, r.end)),
        '등록 ' + e(fmtKstSec(r.created)))).join('')).join('')));
  }
  if (flags.length) {
    h.push(section('규칙 확인 ' + flags.length + '건', flags.map(({ r, v }) =>
      item('<b>' + e(r.booker) + '</b> · ' + e(v.join(', ')), e(fmtSlot(r.start, r.end)) + ' · ' + e(eqName(r)))).join('')));
  }
  h.push(section('장비별 예약', !cals.length ? item('이번 주 예약이 없습니다.') :
    '<table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">' + cals.map(cal => {
      const n = booked.filter(r => r.calendarId === cal).length;
      return '<tr><td style="padding:5px 12px 5px 0">' + e(names[cal] || booked.find(r => r.calendarId === cal).equipment) +
        '</td><td align="right" style="padding:5px 0;white-space:nowrap;color:#374151">' + n + '건</td></tr>';
    }).join('') + '</table>'));
  if (rep) {
    h.push(section('지난주 직전 취소', '<div style="color:#6b7280;font-size:13px;padding:4px 0">' + e(rep.summary) + '</div>' +
      (!rep.people.length ? item('직전 취소 없음') : rep.people.map(p =>
        item('<b>' + e(p.booker) + '</b> · ' + e(p.recent),
          p.items.map(x => e(x.slot) + ' · ' + e(x.eq) + ' · ' + e(x.cancelled) + ' 취소').join('<br>'))).join(''))));
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
  // 최근 몇 주(지난주 포함) 누적: 직전 취소·사용 건수
  const weeks = Math.max(1, CONFIG.REPORT_LATE_WEEKS || 4);
  const from = weekStart - (weeks - 1) * WEEK_MS;
  const span = new Map(summarizeWeek(Store.all().filter(r => r.start >= from && r.start < weekEnd).map(canon), now)
    .map(p => [p.bookerKey, p]));
  // 누적 직전 취소가 많은 순(같으면 지난주 직전 취소가 많은 순, 누적 사용이 적은 순, 이름순)
  const people = all.filter(p => p.late)
    .map(p => {
      const s = span.get(p.bookerKey) || p;
      return {
        booker: p.booker, late: p.late, recentLate: s.late, recentUsed: s.used.length,
        recent: weeks + '주간 직전 취소 ' + s.late + '건 · 사용 ' + s.used.length + '건',
        items: p.cancelled.filter(r => r.late).sort(byStart_)
          .map(r => ({ slot: fmtSlot(r.start, r.end), eq: eqName(r), cancelled: fmtKst(r.cancelled) }))
      };
    })
    .sort((a, b) => b.recentLate - a.recentLate || b.late - a.late || a.recentUsed - b.recentUsed ||
      String(a.booker).localeCompare(String(b.booker)));

  const sheetRows = all.map(p => [new Date(weekStart), p.booker, p.used.length, p.normal + p.moved, p.late,
    p.rate === null ? '' : p.rate,
    p.used.map(r => fmtSlot(r.start, r.end) + ' ' + eqName(r)).join('\n'),
    p.cancelled.map(r => fmtSlot(r.start, r.end) + ' ' + eqName(r) + (r.late ? ' (직전 취소)' : '')).join('\n')]);
  return {
    summary: '사용 ' + used + '건 · 직전 취소 ' + late + '건, ' + fmtKst(weekStart).slice(0, 8) + '~',
    people, sheetRows, used, late
  };
}

const byStart_ = (a, b) => a.start - b.start;
