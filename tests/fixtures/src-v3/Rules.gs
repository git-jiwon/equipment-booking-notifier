/**
 * 예약 규칙 계산 — 시트·캘린더에 의존하지 않는 순수 함수만 둔다(tests/rules.test.js에서 검사).
 * 시각은 모두 epoch 밀리초. 한국 시간(UTC+9, 서머타임 없음)으로 직접 계산한다.
 */
const KST_MS = 9 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

// 세션 경계(한국 시각 시): 00 09 12 15 18 21
const SLOT_HOURS = [0, 9, 12, 15, 18, 21];

const KIND = {
  PRIORITY: '정기예약',     // 그 주가 시작되기 전 일 18:00 ~ 월 09:00에 등록
  ADDITIONAL: '추가예약',   // 그 주 월 09:00 ~ 다음 월 09:00에 등록
  EARLY: '기간전예약',      // 그 주 예약이 열리기(일 18:00) 전에 미리 등록 — 규칙 위반. 예약자에게 개인 메일
  CLASS: '수업예약',        // 'UserC for class' 같은 수업용 예약. 직전 취소·이행률·규칙 확인에서 뺀다
  MAINTENANCE: '점검'       // '[Fix] …' 장비 수리·점검. 직전 취소·이행률·규칙 확인에서 빼고, 중복 순위는 1순위
};

/** 사람의 사용이 아니어서 직전 취소·이행률·규칙 확인에서 빼는 구분 */
const isExcludedKind = k => k === KIND.CLASS || k === KIND.MAINTENANCE;

// 기록 상태
const STATUS = {
  ACTIVE: '예약',
  CANCELLED: '취소',
  MOVED: '변경',      // 다른 시간·장비로 옮김(원래 시간은 직전 취소 판정)
  TRANSFERRED: '양도', // 제목의 이름이 바뀜(슬롯은 비지 않음, 이행률에서 뺌)
  DUPLICATE: '중복'    // 같은 일정의 기록이 둘 남아 하나를 정리한 것(집계·브리핑·알림에서 뺌)
};

/** 사용 주의 시작(월요일 09:00 KST). 월 00:00~09:00 세션은 전 주에 속한다. */
function weekStartFor(ms) {
  const v = ms + KST_MS - 9 * HOUR_MS;           // 월 09:00 KST → 가상 월 00:00
  const dow = (new Date(v).getUTCDay() + 6) % 7; // 월=0
  const dayStart = Math.floor(v / DAY_MS) * DAY_MS;
  return dayStart - dow * DAY_MS - KST_MS + 9 * HOUR_MS;
}

/** 그 주의 예약 시작 시각(일요일 18:00 KST) */
function bookingOpenFor(weekStartMs) {
  return weekStartMs - 15 * HOUR_MS;
}

/** 사용일 시작(09:00 KST). 09:00 ~ 다음날 09:00이 하루(6세션). */
function usageDayStart(ms) {
  const v = ms + KST_MS - 9 * HOUR_MS;
  return Math.floor(v / DAY_MS) * DAY_MS - KST_MS + 9 * HOUR_MS;
}

/** 달력 날짜 시작(00:00 KST) */
function calendarDayStart(ms) {
  return Math.floor((ms + KST_MS) / DAY_MS) * DAY_MS - KST_MS;
}

/** 사용일 키 'YYYY-MM-DD' (09:00 기준) */
function usageDayKey(ms) {
  return new Date(usageDayStart(ms) + KST_MS).toISOString().slice(0, 10);
}

/**
 * 등록 시각으로 예약 구분. 반복 일정도 같다(회차마다 그 주의 예약 시작 전에 만들어졌으면 기간전예약).
 * isClass: 수업 예약(for class)
 */
function classifyBooking(createdMs, startMs, recurring, special) {
  if (special === true) return KIND.CLASS;
  if (special) return special; // KIND.CLASS·KIND.MAINTENANCE
  const ws = weekStartFor(startMs);
  if (createdMs < bookingOpenFor(ws)) return KIND.EARLY;
  if (createdMs < ws) return KIND.PRIORITY;
  return KIND.ADDITIONAL;
}

/**
 * 이 시각 이후 취소하면 직전 취소.
 * - 정기예약·기간전예약: 규칙이 시작된 뒤(기본 월 09:00)
 * - 추가예약: 사용 당일(기본 09:00 ~ 다음날 09:00)
 * 어느 경우든 사용 시작 시각보다 늦지 않다.
 */
function lateCancelFrom(kind, startMs, cfg) {
  let t;
  if (kind === KIND.ADDITIONAL) {
    t = cfg.ADDITIONAL_LATE_DAY === 'CALENDAR_DAY' ? calendarDayStart(startMs) : usageDayStart(startMs);
  } else {
    const ws = weekStartFor(startMs);
    t = cfg.PRIORITY_LATE_FROM === 'BOOKING_OPEN' ? bookingOpenFor(ws) : ws;
  }
  return Math.min(t, startMs);
}

/** 등록 후 유예 시간 안에 지움 */
function withinGrace(createdMs, cancelMs, cfg) {
  const grace = (cfg.GRACE_MINUTES || 0) * 60 * 1000;
  return grace > 0 && cancelMs - createdMs <= grace;
}

/**
 * 직전 취소 여부. 사용 시작 뒤에 지워도 직전 취소다(기준 시각은 사용 시작보다 늦지 않다).
 */
function isLateCancel(kind, createdMs, startMs, cancelMs, cfg) {
  if (isExcludedKind(kind) || withinGrace(createdMs, cancelMs, cfg)) return false;
  return cancelMs >= lateCancelFrom(kind, startMs, cfg);
}

/** ms가 속한 세션의 시작 */
function slotStartFor(ms) {
  const day = calendarDayStart(ms);
  const h = (ms - day) / HOUR_MS;
  let best = 0;
  for (const s of SLOT_HOURS) if (s <= h) best = s;
  return day + best * HOUR_MS;
}

/** ms 다음 세션 경계 */
function nextSlotBoundary(ms) {
  const day = calendarDayStart(ms);
  const h = (ms - day) / HOUR_MS;
  for (const s of SLOT_HOURS) if (s > h) return day + s * HOUR_MS;
  return day + DAY_MS;
}

/**
 * 예약이 차지하는 세션 수.
 * 세션 경계에 맞으면 걸친 세션 수(24:00~09:00은 9시간이어도 1세션),
 * 맞지 않으면(예: 19:00~22:00, 13:30~18:00) 3시간을 1세션으로 올림하여 센다.
 */
function sessionsCovered(startMs, endMs) {
  if (isSlotAligned(startMs, endMs)) {
    let n = 0;
    for (let s = startMs; s < endMs; s = nextSlotBoundary(s)) n++;
    return n;
  }
  return Math.max(1, Math.ceil((endMs - startMs) / (3 * HOUR_MS) - 1e-9));
}

/** 시작·종료가 세션 경계에 맞는지 */
function isSlotAligned(startMs, endMs) {
  return slotStartFor(startMs) === startMs && slotStartFor(endMs) === endMs && endMs > startMs;
}

/** 사람 구분 키: 대소문자·공백을 무시('가 나다' = '가나다') */
function bookerKeyOf(name) {
  return String(name || '').replace(/\s+/g, '').toLowerCase();
}

const TIME_RANGE_RE_ = /\d{1,2}(:\d{2})?\s*(시|am|pm)?\s*[-~–—]\s*\d{1,2}(:\d{2})?\s*(시|am|pm)?/gi;
const NAME_SPLIT_RE_ = /\s*[(\[（【]|\s+for\s+|\s+[-–—]\s+|\s*[\/|,;·&+]\s*|\s+및\s+|\s*:\s*/i;

/**
 * 일정 제목에서 예약자 이름을 읽는다. 읽을 이름이 없으면 ''.
 *   'UserA (BCP)' → 'UserA',  'UserB(Ag)' → 'UserB',  'UserC for class' → 'UserC',
 *   'UserC for class - 마바사' → '마바사'(대신 잡은 예약은 실제 사용자),  'UserA - BCP' → 'UserA',
 *   '다라마 Example Lab (12-3시 only Fume hood)' → '다라마 Example Lab',
 *   '[AFM] UserE' → 'UserE',  'UserA 12:00-15:00' → 'UserA',  'UserA & UserB' → 'UserA'
 * aliases: [{name, aliases:[...]}] — 「사용자」 시트. 제목에서 읽은 이름이나 제목 앞부분이
 *          별칭과 같으면 대표 이름으로 묶는다(예: usera, 나다 → 가나다 / 'UserE AFM' → UserE).
 */
function parseBooker(title, aliases) {
  const t0 = String(title || '').replace(/\s+/g, ' ').trim();
  // 'UserC for class - 마바사', 'UserC for 마바사': 다른 사람이 대신 잡은 예약 → 실제 사용자는 뒤의 이름
  const forM = /\s+for\s+(.+)$/i.exec(t0);
  if (forM) {
    const parts = forM[1].split(/\s+[-–—]\s+/);
    const last = parts.length > 1 ? parts[parts.length - 1].trim() : '';
    const user = last ? parseName_(last, aliases) : knownUser_(forM[1], aliases);
    if (user) return user;
  }
  return parseName_(t0, aliases);
}

/** 'for' 뒤가 「사용자」 시트의 이름·별칭이거나 한글 이름(2~4자)이면 그 사람 */
function knownUser_(text, aliases) {
  const name = parseName_(text, aliases);
  if (!name) return '';
  const key = bookerKeyOf(name);
  const u = aliasOwner_(key, aliases);
  if (u) return u.name;
  return /^[가-힣]{2,4}$/.test(name) ? name : '';
}

function parseName_(title, aliases) {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(\s*[\[(（【][^\])）】]*[\])）】]\s*)+/, '');   // 앞의 [AFM] (Ag) 같은 묶음
  t = t.replace(TIME_RANGE_RE_, ' ').replace(/\s+/g, ' ').trim(); // 12:00-15:00, 3-6시
  t = t.replace(/^[^\p{L}\p{N}]+/u, '').trim();                   // 앞의 기호·이모지
  if (!t) return '';
  let name = t.split(NAME_SPLIT_RE_)[0].trim() || t;
  const key = bookerKeyOf(name);
  const tl = t.toLowerCase();
  let best = null;
  const exact = aliasOwner_(key, aliases);
  if (exact) return exact.name;
  for (const u of aliases || []) {
    for (const a of [u.name].concat(u.aliases || [])) {
      const al = String(a || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!al) continue;
      // 제목이 별칭으로 시작하고 바로 뒤가 글자·숫자·'-글자'가 아니면 같은 사람
      const next = tl.slice(al.length, al.length + 2);
      if (tl.indexOf(al) === 0 && !/^[\p{L}\p{N}]/u.test(next) && !/^-\p{L}/u.test(next) &&
          (!best || al.length > best.len)) best = { name: u.name, len: al.length };
    }
  }
  if (best) return best.name;
  if (/^[a-z]/.test(name)) name = name.charAt(0).toUpperCase() + name.slice(1);
  return name;
}

/**
 * 이 이름(키)의 「사용자」 행. 다른 행의 별칭 칸에 적힌 것을 먼저 본다
 * (자동으로 추가된 'UserA' 행이 있어도, 관리자가 '가나다' 행의 별칭에 UserA을 적었으면 가나다).
 */
function aliasOwner_(key, aliases) {
  if (!key) return null;
  return (aliases || []).find(u => (u.aliases || []).some(a => bookerKeyOf(a) === key)) ||
    (aliases || []).find(u => bookerKeyOf(u.name) === key) || null;
}

/** 「사용자」 시트의 대표 이름(이름이나 별칭과 대소문자·공백만 다르면 같은 사람). 없으면 그대로 */
function canonicalName(name, aliases) {
  const u = aliasOwner_(bookerKeyOf(name), aliases);
  return u ? u.name : name;
}

/** 새 이름이 옛 이름에 덧붙인 것인지('UserD' → 'UserD sample B'): 같은 사람으로 본다 */
function extendsName(newName, oldName) {
  const n = String(newName || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const o = String(oldName || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!n || !o) return false;
  if (n === o) return true;
  const next = n.slice(o.length, o.length + 2);
  return n.indexOf(o) === 0 && !/^[\p{L}\p{N}]/u.test(next) && !/^-\p{L}/u.test(next);
}

/** 같은 캘린더에서 겹치는지 */
function overlaps(a, b) {
  return a.calendarId === b.calendarId && a.start < b.end && a.end > b.start;
}

/** 순위 시각 = 캘린더 등록 시각 */
const rankTime = r => r.created;

/** 중복 예약 순위: 점검이 먼저(장비를 쓸 수 없는 시간), 그다음 캘린더에 먼저 등록한 순(초 단위) */
function rankCompare(a, b) {
  return (b.kind === KIND.MAINTENANCE) - (a.kind === KIND.MAINTENANCE) || a.created - b.created ||
    String(a.eventId).localeCompare(String(b.eventId));
}

/** 묶음(순위 순)에서 i번째가 겹치는 앞 순위 예약들 — 비어 있으면 양보할 필요 없음 */
function higherOverlaps(group, i) {
  return group.slice(0, i).filter(o => overlaps(o, group[i]));
}

/**
 * 겹치는 예약 묶음(같은 캘린더). rows: 「예약」 상태 기록.
 * 반환: [[1순위, 2순위, ...], ...] — 두 건 이상인 묶음만, 시작 순
 */
function conflictGroups(rows) {
  const byCal = {};
  const seen = new Set();
  for (const r of rows) {
    // 같은 일정의 기록이 둘 남아 있어도 한 예약이다(서로 겹치는 다른 예약이 아님)
    const k = r.calendarId + '|' + r.eventId;
    if (seen.has(k)) continue;
    seen.add(k);
    (byCal[r.calendarId] = byCal[r.calendarId] || []).push(r);
  }
  const out = [];
  for (const cal of Object.keys(byCal)) {
    const list = byCal[cal].slice().sort((a, b) => a.start - b.start || a.end - b.end);
    let group = [];
    let groupEnd = -Infinity;
    for (const r of list) {
      if (group.length && r.start < groupEnd) {
        group.push(r);
        groupEnd = Math.max(groupEnd, r.end);
      } else {
        if (group.length > 1) out.push(group);
        group = [r];
        groupEnd = r.end;
      }
    }
    if (group.length > 1) out.push(group);
  }
  return out.map(g => g.sort(rankCompare)).sort((a, b) =>
    Math.min(...a.map(r => r.start)) - Math.min(...b.map(r => r.start)));
}

/** 정기예약 기간 하루 제한에 드는 예약인지 */
function countsForDayLimit_(r) {
  return !isExcludedKind(r.kind) && r.created < weekStartFor(r.start);
}

/**
 * 한 예약의 규칙 위반 목록. others: 다른 「예약」 상태 기록(전체)
 */
function checkViolations(r, others, cfg) {
  const out = [];
  if (r.kind === KIND.EARLY) out.push('기간전예약');
  if (cfg.CHECK_SLOT_ALIGNMENT && !isSlotAligned(r.start, r.end)) {
    out.push('세션 시간(09·12·15·18·21·24시 경계)과 맞지 않음');
  }
  const exempt = id => (cfg.DAY_LIMIT_EXEMPT || []).indexOf(id) >= 0; // 하루 제한에서 뺀 장비
  if (countsForDayLimit_(r) && r.bookerKey && !exempt(r.calendarId)) {
    // 하루 제한은 정기예약 기간이 끝날 때(월 09:00)의 시간으로 판정한다(그 뒤 빈 시간으로 늘린 것은 추가 예약)
    const span = x => (x.windowStart ? [x.windowStart, x.windowEnd] : [x.start, x.end]);
    const [rs, re] = span(r);
    const day = usageDayKey(rs);
    let sessions = sessionsCovered(rs, re);
    for (const o of others) {
      if (o.eventId === r.eventId || o.bookerKey !== r.bookerKey || !countsForDayLimit_(o) || exempt(o.calendarId)) continue;
      if (cfg.DAY_LIMIT_SCOPE !== 'ALL' && o.calendarId !== r.calendarId) continue;
      const [os, oe] = span(o);
      if (usageDayKey(os) === day) sessions += sessionsCovered(os, oe);
    }
    if (sessions > cfg.PRIORITY_SESSIONS_PER_DAY) {
      out.push('하루 ' + cfg.PRIORITY_SESSIONS_PER_DAY + '세션 초과');
    }
  }
  for (const o of others) {
    if (o.eventId === r.eventId || !overlaps(o, r)) continue;
    out.push('다른 예약과 시간 겹침(' + o.booker + ')');
  }
  return out;
}

/**
 * 주간 통계. rows: 시작 시각이 그 주에 속한 기록
 * 사용(이행) = 지금 「예약」 상태이고 시작 시각이 지난 기록(사용 시작 뒤에 지우거나 옮기면 직전 취소),
 * 이행률 = 사용 / (사용 + 직전 취소). 양도·수업 예약은 빼고 센다.
 */
function summarizeWeek(rows, nowMs) {
  const people = {};
  for (const r of rows) {
    if (isExcludedKind(r.kind) || r.status === STATUS.DUPLICATE) continue; // 수업·점검, 정리한 중복 기록은 집계하지 않는다
    const key = r.bookerKey || bookerKeyOf(r.booker);
    const p = people[key] || (people[key] = {
      booker: r.booker, bookerKey: key, used: [], cancelled: [], late: 0, normal: 0, moved: 0, transferred: 0, upcoming: 0
    });
    if (r.status === STATUS.ACTIVE) {
      if (r.start <= nowMs) p.used.push(r); else p.upcoming++;
    } else if (r.status === STATUS.TRANSFERRED) {
      p.transferred++;
    } else {
      p.cancelled.push(r);
      if (r.late) p.late++;
      else if (r.status === STATUS.MOVED) p.moved++;
      else p.normal++;
    }
  }
  return Object.keys(people).map(k => {
    const p = people[k];
    const denom = p.used.length + p.late;
    p.rate = denom ? p.used.length / denom : null;
    return p;
  }).sort((a, b) => (a.rate === null) - (b.rate === null) || (a.rate - b.rate) || b.late - a.late ||
    String(a.booker).localeCompare(String(b.booker)));
}

const pad2_ = n => String(n).padStart(2, '0');

/** 'MM/DD(요일) HH:MM' KST */
function fmtKst(ms) {
  const d = new Date(ms + KST_MS);
  const wd = '일월화수목금토'[d.getUTCDay()];
  return pad2_(d.getUTCMonth() + 1) + '/' + pad2_(d.getUTCDate()) + '(' + wd + ') ' +
    pad2_(d.getUTCHours()) + ':' + pad2_(d.getUTCMinutes());
}

/** 'MM/DD(요일) HH:MM:SS' KST — 등록 순서 비교용 */
function fmtKstSec(ms) {
  return fmtKst(ms) + ':' + pad2_(new Date(ms + KST_MS).getUTCSeconds());
}

/** 세션 표기 'MM/DD(요일) 09:00–12:00' (종료 00:00은 24:00, 날짜를 넘기면 종료 날짜도) */
function fmtSlot(startMs, endMs) {
  const e = new Date(endMs + KST_MS);
  let hh = pad2_(e.getUTCHours()) + ':' + pad2_(e.getUTCMinutes());
  let endDay = calendarDayStart(endMs);
  if (hh === '00:00' && endMs > startMs) { hh = '24:00'; endDay -= DAY_MS; }
  const end = endDay > calendarDayStart(startMs) ? fmtKst(endMs).slice(0, 8) + ' ' + hh : hh;
  return fmtKst(startMs) + '–' + end;
}

if (typeof module !== 'undefined') {
  module.exports = {
    KIND, STATUS, isExcludedKind, weekStartFor, bookingOpenFor, usageDayStart, calendarDayStart, usageDayKey,
    classifyBooking, lateCancelFrom, withinGrace, isLateCancel, slotStartFor, sessionsCovered,
    isSlotAligned, bookerKeyOf, parseBooker, overlaps, rankTime, rankCompare, higherOverlaps, conflictGroups, checkViolations,
    summarizeWeek, fmtKst, fmtKstSec, fmtSlot, extendsName, canonicalName
  };
}
