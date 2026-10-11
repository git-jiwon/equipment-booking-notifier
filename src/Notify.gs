/**
 * 알림: 이메일(MailApp, 무료). 그룹 주소 한 통 = 받는 사람 1명으로 센다.
 * - 그룹: 「직전 취소」만([예약취소] 메일). 그 주 슬롯이 직전 취소로 비었을 때, 다른 사람이 바로 예약해 쓸 수 있도록 알린다.
 *         (정상 취소·변경·중복 예약 등은 메일 없이 기록만. 월요일 브리핑에서 한 번에 본다)
 * - 개인: 기간전예약(다음 주 이후를 미리 잡음)을 예약자에게.
 * 보낼 알림은 스크립트 속성에 쌓아 두고, 발송에 실패하면 다음 실행에서 다시 보낸다.
 * (이 파일의 맨 위 코드는 다른 파일의 상수를 쓰지 않는다 — 파일을 읽는 순서와 상관없이 동작하도록)
 */
const Outbox = (() => {
  const KEY = 'outbox';
  const MAX_AGE_MS = 24 * 3600 * 1000; // 쌓은 뒤 하루 넘게 못 보낸 알림은 버린다(로그)
  const MAX_CHARS = 8500;              // 스크립트 속성 값 한도(9KB) 안
  let items = null;
  const props = () => PropertiesService.getScriptProperties();

  function load() {
    if (items) return items;
    try { items = JSON.parse(props().getProperty(KEY) || '[]'); } catch (e) { items = []; }
    return items;
  }
  function save() {
    let json = JSON.stringify(items);
    while (json.length > MAX_CHARS && items.length) {
      const dropped = items.shift();
      console.warn('알림 대기열 한도로 오래된 알림 1건을 버립니다.');
      logPersonalDetails_(JSON.stringify(dropped));
      json = JSON.stringify(items);
    }
    props().setProperty(KEY, json);
  }

  return {
    add(item) {
      load();
      if (items.some(i => i.type === item.type && i.key === item.key)) return;
      items.push(item);
      save();
    },
    /**
     * 기록의 열쇠가 바뀌면(지우고 다시 만든 같은 예약, 시간 조정) 아직 못 보낸 기간전예약 알림도 옮긴다.
     * 취소·변경 알림은 닫힌 행(열쇠가 바뀌지 않음)을 가리키므로 옮기지 않는다
     */
    rekey(from, to) {
      if (from === to) return;
      load();
      let n = 0;
      items.forEach(i => { if (i.key === from && i.type === 'early') { i.key = to; n++; } });
      if (n) save();
    },
    /** 이 기록의 알림을 뺀다(예: 취소가 장비 이동으로 바뀜). key: recordKey */
    drop(key) {
      load();
      const n = items.length;
      items = items.filter(i => i.key !== key);
      if (items.length !== n) save();
    },
    pending() {
      return load().slice();
    },
    flush() {
      if (!load().length) return;
      const now = Date.now();
      const done = new Set();
      const lastMinute = [];
      const earlies = [];
      for (const it of items) {
        // 예전 형식(행 번호) 알림은 버린다. 같은 열쇠가 여럿(같은 시간 양도)이면 알림 종류에 맞는 행
        const row = it.key ? Store.byKey(it.key, r => (it.type === 'early' ? r.status === STATUS.ACTIVE :
          r.status === STATUS.CANCELLED || r.status === STATUS.MOVED)) : null;
        if (!row || now - (it.queuedAt || it.at || now) > MAX_AGE_MS) {
          console.warn('유효기간이 지났거나 기록이 없는 알림 1건을 버립니다.');
          logPersonalDetails_(JSON.stringify(it));
          done.add(it);
        } else if (row.end <= now) {
          done.add(it); // 이미 지난 슬롯
        } else if (it.type === 'early') {
          if (row.status === STATUS.ACTIVE && row.kind === KIND.EARLY) earlies.push({ it, row });
          else done.add(it); // 그사이 지웠거나 구분이 바뀜
        } else if ((it.type === 'cancel' || it.type === 'change') && row.late && row.status !== STATUS.ACTIVE) {
          lastMinute.push({ it, row });
        } else {
          done.add(it); // 예전 종류(정상 취소·중복 예약·일부 취소)는 더 보내지 않는다
        }
      }
      if (lastMinute.length && sendLastMinuteMail_(lastMinute)) lastMinute.forEach(c => done.add(c.it));
      if (earlies.length) sendEarlyMails_(earlies).forEach(it => done.add(it));
      if (done.size) {
        items = items.filter(i => !done.has(i));
        save();
      }
    }
  };
})();

/** 장비 표시 이름(「장비」 시트의 지금 이름, 없으면 기록 당시 이름) */
let equipmentNameCache_ = null;
function eqName_(r) {
  if (!equipmentNameCache_) {
    equipmentNameCache_ = {};
    try { Store.equipments().forEach(e => { equipmentNameCache_[e.calendarId] = e.name; }); } catch (e) { /* 시트 없음 */ }
  }
  return equipmentNameCache_[r.calendarId] || r.equipment;
}

/** [s, e] 중 지금 다른 「예약」이 차지하지 않은 부분 */
function freeParts_(calendarId, s, e, now) {
  let parts = [[Math.max(s, now), e]].filter(p => p[1] > p[0]);
  for (const o of Store.active()) {
    if (o.calendarId !== calendarId) continue;
    const next = [];
    for (const [a, b] of parts) {
      if (o.end <= a || o.start >= b) { next.push([a, b]); continue; }
      if (o.start > a) next.push([a, o.start]);
      if (o.end < b) next.push([o.end, b]);
    }
    parts = next;
  }
  return parts;
}

/**
 * 직전 취소 알림(그룹): 그 주 슬롯의 예약이 직전에 취소됐을 때, 카드 하나로 장비·시간·예약자·취소 시각.
 * 다른 예약이 이미 그 시간을 차지했으면 보내지 않는다.
 * 「예약자」는 일정 제목의 이름이다(캘린더는 지운 사람을 알려 주지 않는다).
 * 반환: 보냈거나 보낼 것이 없으면 true(알림 정리), 실패하면 false(다음 실행에서 다시)
 */
function sendLastMinuteMail_(entries) {
  const now = Date.now();
  const items = entries
    .map(e => ({ row: e.row, parts: freeParts_(e.row.calendarId, e.row.start, e.row.end, now) }))
    .filter(x => x.parts.length)
    .sort((a, b) => a.row.start - b.row.start);
  if (!items.length) return true;
  const fields = x => [
    ['장비', eqName_(x.row)],
    ['시간', fmtSlot(x.row.start, x.row.end)],
    ['예약자', x.row.booker],
    ['취소', fmtKst(x.row.cancelled)]
  ];
  const first = items[0];
  const subject = CONFIG.CANCEL_SUBJECT_PREFIX + ' ' + fmtSlot(first.row.start, first.row.end) + ' · ' + eqName_(first.row) +
    (items.length > 1 ? ' 외 ' + (items.length - 1) + '건' : '');
  const head = items.length === 1 ? eqName_(first.row) + ' 예약이 취소되었습니다.' : '예약 ' + items.length + '건이 취소되었습니다.';

  const text = [head, ''];
  items.forEach(x => { fields(x).forEach(([k, v]) => text.push(k + ': ' + v)); text.push(''); });

  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const card = x => '<table cellpadding="0" cellspacing="0" style="border-collapse:separate;border:1px solid #e3e6ea;' +
    'border-radius:8px;background:#f8f9fb;margin:0 0 10px 0"><tr><td style="padding:10px 16px">' +
    '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;line-height:1.7">' +
    fields(x).map(([k, v]) => '<tr><td style="color:#6b7280;padding:0 18px 0 0;white-space:nowrap;vertical-align:top">' + esc(k) +
      '</td><td style="color:#222">' + (k === '예약자' ? '<b>' + esc(v) + '</b>' : esc(v)) + '</td></tr>').join('') +
    '</table></td></tr></table>';
  // 한 건이면 첫 줄의 장비 이름을 굵게
  const headHtml = items.length === 1 ? '<b>' + esc(eqName_(first.row)) + '</b> 예약이 취소되었습니다.' : esc(head);
  const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6;max-width:' +
    (CONFIG.MAIL_MAX_WIDTH || 560) + 'px">' +
    '<p style="margin:0 0 12px 0">' + headHtml + '</p>' + items.map(card).join('') + '</div>';
  return sendGroupMail_(subject, text.join('\n').trim(), null, html);
}

/**
 * 개인 메일 주소: 「사용자」 시트의 이메일 → 일정을 만든 계정(관리자·그룹·캘린더 계정이 아니면) → 없음('')
 */
function personalEmail_(row) {
  const aliases = Store.aliases();
  const name = canonicalName(row.booker, aliases);
  const u = aliases.find(x => x.name === name);
  if (u && u.email) return isSingleEmail_(u.email) ? u.email : '';
  const c = String(row.creator || '').trim().toLowerCase();
  const shared = CONFIG.ADMIN_EMAILS.map(e => e.toLowerCase()).concat([String(CONFIG.GROUP_EMAIL).toLowerCase()]);
  if (isSingleEmail_(c) && !/calendar\.google\.com$/.test(c) && shared.indexOf(c) < 0) return c;
  return '';
}

/** 기간전예약 개인 메일: 받는 사람마다 한 통. 주소를 모르면 관리자에게. 반환: 보낸 알림들 */
function sendEarlyMails_(entries) {
  const byTo = new Map();
  for (const e of entries) {
    const to = personalEmail_(e.row);
    if (!byTo.has(to)) byTo.set(to, []);
    byTo.get(to).push(e);
  }
  const sent = [];
  for (const [to, list] of byTo) {
    list.sort((a, b) => a.row.start - b.row.start);
    const r0 = list[0].row;
    const names = Array.from(new Set(list.map(e => e.row.booker))).join(', ');
    const subject = CONFIG.SUBJECT_PREFIX + ' 기간전예약 안내 · ' + names + ' · ' + fmtSlot(r0.start, r0.end) +
      (list.length > 1 ? ' 외 ' + (list.length - 1) + '건' : '');
    const lines = [
      names + '님, 아직 예약을 받지 않는 주의 시간이 예약되어 있습니다(기간전예약).',
      '그 주 예약은 일요일 18:00부터 할 수 있으니, 아래 일정은 지우고 그때 다시 잡아 주세요.',
      ''
    ];
    for (const { row } of list) {
      lines.push('■ ' + eqName_(row));
      lines.push('  ' + fmtSlot(row.start, row.end) + ' (예약 시작 ' + fmtKst(bookingOpenFor(weekStartFor(row.start))) + ')');
    }
    if (list.some(e => /_\d{8}/.test(e.row.eventId))) {
      lines.push('', '반복 일정이면 이번 주 회차까지만 남도록 반복 종료일을 줄여 주세요.');
    }
    const body = lines.join('\n');
    const ok = to ? sendMail_({ to, subject, body }) :
      sendAdminMail_(subject + ' (주소 없음)', '「사용자」 시트에 ' + names + '의 이메일이 없어 관리자에게 보냅니다. ' +
        '이메일 칸을 채우면 다음부터 본인에게 갑니다.\n\n' + body);
    if (ok) list.forEach(e => sent.push(e.it));
  }
  return sent;
}

/** 기록 시트 링크 줄(HTML에서는 「예약기록 시트 열기」 링크) */
function sheetLink_() {
  return '기록 보기: ' + SpreadsheetApp.getActive().getUrl();
}

/**
 * 일반 텍스트 본문을 HTML로도 보낸다(일반 텍스트는 받는 쪽에서 긴 줄을 아무 데서나 자름).
 * ■·▶ 줄은 굵게, 앞 공백은 들여쓰기, '—' 줄 아래는 작은 회색 글씨, 기록 주소는 링크.
 */
const FOOTER_MARK = '—';
function toHtml_(text) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtLine = line => {
    const link = /^기록 보기: (https?:\/\/\S+)$/.exec(line);
    if (link) return '<a href="' + esc(link[1]) + '">예약기록 시트 열기</a>';
    let h = esc(line).replace(/^ +/, m => '&nbsp;'.repeat(m.length)).replace(/ {2,}/g, m => '&nbsp;'.repeat(m.length));
    if (/^\s*(■|▶)/.test(line)) h = '<b>' + h + '</b>';
    return h;
  };
  const lines = String(text).split('\n');
  const cut = lines.lastIndexOf(FOOTER_MARK);
  const main = cut >= 0 ? lines.slice(0, cut) : lines;
  const foot = cut >= 0 ? lines.slice(cut + 1) : [];
  while (main.length && !main[main.length - 1].trim()) main.pop();
  return '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#222;max-width:' +
    (CONFIG.MAIL_MAX_WIDTH || 560) + 'px">' +
    main.map(fmtLine).join('<br>') +
    (foot.length ? '<div style="margin-top:18px;padding-top:10px;border-top:1px solid #ddd;font-size:12px;line-height:1.5;color:#666">' +
      foot.map(fmtLine).join('<br>') + '</div>' : '') + '</div>';
}

/**
 * 그룹 주소로 보낸다. 답장은 관리자에게(그룹 전체 답장 방지).
 * 그룹 주소가 비어 있으면 관리자에게만. 실패하면 false(알림은 남아 다음 실행에서 다시 보냄).
 */
function sendGroupMail_(subject, body, extraCc, html) {
  const admins = CONFIG.ADMIN_EMAILS.filter(Boolean);
  const to = CONFIG.GROUP_EMAIL || admins.join(',');
  const cc = Array.from(new Set((CONFIG.GROUP_EMAIL && CONFIG.CC_ADMIN ? admins : []).concat(extraCc || [])))
    .filter(e => e && e !== to).join(',');
  return sendMail_({ to, cc, subject, body, html });
}

function sendAdminMail_(subject, body, html) {
  return sendMail_({ to: CONFIG.ADMIN_EMAILS.filter(Boolean).join(','), subject, body, html });
}

function sendMail_(m) {
  if (!m.to) return false;
  const validList = value => typeof value === 'string' && !/[\r\n]/.test(value) &&
    value.split(',').every(e => isSingleEmail_(e.trim()));
  if (!validList(m.to) || (m.cc && !validList(m.cc)) ||
      /[\r\n]/.test(String(m.subject || '') + String(CONFIG.SENDER_NAME || '')) ||
      (CONFIG.ADMIN_EMAILS[0] && !isSingleEmail_(CONFIG.ADMIN_EMAILS[0]))) {
    console.warn('메일 주소 또는 헤더 형식이 올바르지 않아 발송을 중단했습니다.');
    return false;
  }
  try {
    const msg = { to: m.to, subject: m.subject, body: m.body, htmlBody: m.html || toHtml_(m.body), name: CONFIG.SENDER_NAME };
    if (m.cc) msg.cc = m.cc;
    if (CONFIG.ADMIN_EMAILS[0]) msg.replyTo = CONFIG.ADMIN_EMAILS[0];
    MailApp.sendEmail(msg);
    return true;
  } catch (err) {
    console.error('메일 발송 실패 / 남은 일일 할당량: ' + safeQuota_());
    logPersonalDetails_('메일 발송 실패(' + m.subject + '): ' + err);
    return false;
  }
}

/** 개인 알림 수신자는 표시 이름이나 주소 목록 없이 이메일 한 개만 허용한다. */
function isSingleEmail_(value) {
  return typeof value === 'string' && value === value.trim() &&
    !/[\s,;]/.test(value) &&
    /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value);
}

/** 진단용 원본 데이터는 관리자가 설정으로 명시한 경우에만 로그에 남긴다. */
function logPersonalDetails_(message) {
  if (CONFIG.LOG_PERSONAL_DETAILS === true) console.log(message);
}

function safeQuota_() {
  try { return MailApp.getRemainingDailyQuota(); } catch (e) { return '?'; }
}
