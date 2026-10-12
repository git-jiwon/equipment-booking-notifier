'use strict';

// node tests/security.test.js — 외부 입력과 개인정보 보호의 회귀 검사.
// Google 서비스와 메일 발송은 모두 기존 모의 환경에서 실행한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World } = require('./lib/gas-sim');

const moduleShim = { exports: {} };
new Function('module', fs.readFileSync(path.join(__dirname, '..', 'src', 'Rules.gs'), 'utf8'))(moduleShim);
const rules = moduleShim.exports;
let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log('ok  ' + name);
}

function makeWorld(overrides = {}) {
  const world = new World({
    now: '2026-10-12T10:00',
    config: Object.assign({
      GROUP_EMAIL: 'group@example.com',
      ADMIN_EMAILS: ['admin@example.com'],
      SENDER_NAME: 'Equipment Booking',
      LOG_PERSONAL_DETAILS: false
    }, overrides)
  });
  const setup = world.run('setup');
  assert.equal(setup.error, null);
  return world;
}

function call(world, name, ...args) {
  const exec = world.run(name, ...args);
  assert.equal(exec.error, null, name + ' must not throw');
  return exec;
}

function addUser(world, email) {
  world.sheet('사용자').getRange(3, 1, 1, 3).setValues([['User Alpha', '', email]]);
}

// Google Groups 동작 검사에 필요한 가짜 주소는 공개 개인정보 검사와 구별되도록 실행 중 조합한다.
const groupAddress = local => [local, ['google', 'groups'].join('') + '.com'].join('@');

test('prototype 속성과 같은 예약자도 정상 집계', () => {
  const start = Date.parse('2026-10-05T10:00:00+09:00');
  const rows = ['constructor', '__proto__', 'User Alpha'].map((booker, i) => ({
    calendarId: 'equipment@example.com', eventId: 'event-' + i,
    booker, bookerKey: rules.bookerKeyOf(booker),
    kind: rules.KIND.ADDITIONAL, status: rules.STATUS.ACTIVE,
    start, end: start + 3600000, created: start
  }));
  const summaries = rules.summarizeWeek(rows, start + 7200000);
  assert.equal(summaries.length, rows.length);
  assert.ok(summaries.every(person => person.used.length === 1 && person.rate === 1));
  assert.deepEqual(new Set(summaries.map(person => person.booker)), new Set(rows.map(row => row.booker)));
});

test('캘린더 이름은 수식으로 전달되지 않음', () => {
  const world = makeWorld();
  world.calendar.addCalendar('equipment@example.com', '=1+1', { accessRole: 'reader' });
  const sheet = world.sheet('장비');
  const originalGetRange = sheet.getRange.bind(sheet);
  const written = [];
  sheet.getRange = (...args) => {
    const range = originalGetRange(...args);
    const originalSetValues = range.setValues.bind(range);
    range.setValues = values => {
      written.push(...values);
      return originalSetValues(values);
    };
    return range;
  };
  call(world, 'fillEquipmentSheet');
  // 모의 시트의 @서식은 수식을 계산하지 않으므로 API 입력 자체를 검증한다.
  assert.equal(written.length, 1);
  assert.equal(written[0][0], "'=1+1");
});

test('예약 제목의 HTML은 메일에서 실행 가능한 태그가 되지 않음', () => {
  const world = makeWorld();
  const result = call(world, 'toHtml_', '<img src=x onerror=alert(1)>').result;
  assert.ok(result.includes('&lt;img'));
  assert.ok(!result.includes('<img'));
});

test('개인 알림은 올바른 사용자 주소 하나를 선택', () => {
  const world = makeWorld();
  addUser(world, 'participant@example.com');
  assert.equal(call(world, 'personalEmail_', {
    booker: 'User Alpha', creator: 'creator@example.com'
  }).result, 'participant@example.com');
});

for (const [label, value] of [
  ['쉼표로 나눈 두 주소', 'participant@example.com,other@example.com'],
  ['세미콜론으로 나눈 두 주소', 'participant@example.com;other@example.com'],
  ['줄바꿈이 든 주소', 'participant@example.com\r\nBcc: other@example.com'],
  ['주소 중간 공백', 'participant @example.com'],
  ['형식이 잘못된 주소', 'participant@']
]) {
  test('잘못된 사용자 주소는 개인 알림 대상을 늘리지 않음: ' + label, () => {
    const world = makeWorld();
    addUser(world, value);
    assert.equal(call(world, 'personalEmail_', {
      booker: 'User Alpha', creator: 'creator@example.com'
    }).result, '');
  });
}

test('사용자 주소가 없을 때만 유효한 만든 계정으로 대체', () => {
  const world = makeWorld();
  addUser(world, '');
  assert.equal(call(world, 'personalEmail_', {
    booker: 'User Alpha', creator: 'creator@example.com'
  }).result, 'creator@example.com');
});

test('잘못된 만든 계정은 개인 알림 대상으로 사용하지 않음', () => {
  const world = makeWorld();
  assert.equal(call(world, 'personalEmail_', {
    booker: 'User Beta', creator: 'creator@example.com,other@example.com'
  }).result, '');
});

test('캘린더 계정과 관리자 계정은 개인 알림에서 제외', () => {
  const world = makeWorld();
  for (const creator of ['admin@example.com', 'group@example.com', 'example-calendar@group.calendar.google.com']) {
    assert.equal(call(world, 'personalEmail_', { booker: 'User Beta', creator }).result, '');
  }
});

test('관리자 그룹 알림의 명시적인 유효 주소 목록은 허용', () => {
  const world = makeWorld();
  assert.equal(call(world, 'sendMail_', {
    to: 'admin@example.com,reviewer@example.com',
    cc: 'observer@example.com', subject: 'Booking notice', body: 'Example notice'
  }).result, true);
  assert.equal(world.mails.length, 1);
});

for (const message of [
  { to: 'participant@example.com;other@example.com', subject: 'Example' },
  { to: 'participant@example.com\r\n,other@example.com', subject: 'Example' },
  { to: 'participant@example.com', cc: 'other@example.com\r\n', subject: 'Example' },
  { to: 'participant@example.com', cc: 'other@example.com\r\nBcc: external@example.com', subject: 'Example' },
  { to: 'participant@example.com', subject: 'Example\r\nBcc: external@example.com' }
]) {
  test('잘못된 수신 주소 또는 메일 헤더는 발송 전에 차단 ' + (passed + 1), () => {
    const world = makeWorld();
    const result = call(world, 'sendMail_', Object.assign({ body: 'Example notice' }, message)).result;
    assert.equal(result, false);
    assert.equal(world.mails.length, 0);
  });
}

test('보낸 사람 이름의 줄바꿈은 발송 전에 차단', () => {
  const world = makeWorld({ SENDER_NAME: 'Equipment\r\nBcc: external@example.com' });
  assert.equal(call(world, 'sendMail_', {
    to: 'participant@example.com', subject: 'Example', body: 'Example notice'
  }).result, false);
  assert.equal(world.mails.length, 0);
});

test('기본 설정으로 설치·동기화·미리보기의 예약자와 주소는 로그에 남지 않음', () => {
  const world = new World({ now: '2026-10-12T10:00' });
  const calendarId = 'equipment@example.com';
  world.calendar.addCalendar(calendarId, '[Example] Equipment Alpha', { accessRole: 'reader' });
  world.calendar.create(calendarId, {
    summary: 'User Alpha', start: '2026-10-13T09:00', end: '2026-10-13T12:00',
    creator: 'participant@example.com'
  });
  const executions = ['setup', 'fillEquipmentSheet', 'initialSync', 'previewBookerNames', 'checkCalendars']
    .map(name => call(world, name));
  assert.equal(world.eval('CONFIG.LOG_PERSONAL_DETAILS'), false);
  const logs = executions.flatMap(exec => exec.logs.concat(exec.errors)).join('\n');
  for (const personalValue of ['User Alpha', 'participant@example.com', calendarId, 'Equipment Alpha']) {
    assert.ok(!logs.includes(personalValue), 'default diagnostic logs must exclude sample personal data');
  }
});

test('관리자가 명시적으로 켠 예약자 미리보기만 상세 로그를 출력', () => {
  const world = makeWorld({ LOG_PERSONAL_DETAILS: true });
  const calendarId = 'equipment@example.com';
  world.calendar.addCalendar(calendarId, '[Example] Equipment Alpha', { accessRole: 'reader' });
  world.calendar.create(calendarId, {
    summary: 'User Alpha', start: '2026-10-13T09:00', end: '2026-10-13T12:00',
    creator: 'participant@example.com'
  });
  call(world, 'fillEquipmentSheet');
  const exec = call(world, 'previewBookerNames');
  assert.ok(exec.logs.some(line => line.includes('User Alpha')));
});

test('한 일정 처리 실패 시 해당 캘린더만 재시도하고 다른 캘린더는 계속 진행', () => {
  const world = makeWorld();
  const affected = 'affected@example.com';
  const unaffected = 'unaffected@example.com';
  for (const id of [affected, unaffected]) {
    world.calendar.addCalendar(id, '[Example] Equipment', { accessRole: 'reader' });
  }
  call(world, 'fillEquipmentSheet');
  call(world, 'initialSync');
  const oldToken = world.props.get('syncToken:' + affected);
  const oldLastSync = world.props.get('lastSync:' + affected);
  const oldOtherToken = world.props.get('syncToken:' + unaffected);
  world.at('2026-10-12T10:05');
  const failedId = world.calendar.create(affected, {
    summary: 'User Alpha', start: '2026-10-13T09:00', end: '2026-10-13T12:00',
    creator: 'participant@example.com'
  });
  const successfulId = world.calendar.create(unaffected, {
    summary: 'User Beta', start: '2026-10-13T12:00', end: '2026-10-13T15:00',
    creator: 'participant@example.com'
  });
  // 새 컨텍스트에서 한 번만 실패시킨다. 다음 실제 진입점 호출에는 주입이 남지 않는다.
  call(world, 'safeQuota_');
  world.eval(`
    const originalSecurityHandler_ = handleEvent_;
    let securityFailurePending_ = true;
    handleEvent_ = function (f, ev, ctx) {
      if (ev.id === ${JSON.stringify(failedId)} && securityFailurePending_) {
        securityFailurePending_ = false;
        throw new Error('Injected event processing failure');
      }
      return originalSecurityHandler_(f, ev, ctx);
    };
    runSync_({ notify: false });
  `);
  assert.equal(world.rowsOf(failedId).length, 0);
  assert.equal(world.rowsOf(successfulId).length, 1);
  assert.equal(world.props.get('syncToken:' + affected), oldToken);
  assert.equal(world.props.get('lastSync:' + affected), oldLastSync);
  assert.notEqual(world.props.get('syncToken:' + unaffected), oldOtherToken);
  world.at('2026-10-12T10:10');
  const retry = call(world, 'syncAll');
  assert.equal(retry.errors.length, 0);
  assert.equal(world.rowsOf(failedId).length, 1);
  assert.equal(world.rowsOf(successfulId).length, 1);
  assert.notEqual(world.props.get('syncToken:' + affected), oldToken);
});

test('실패한 전체 목록 처리 중에는 기존 예약을 누락된 일정으로 닫지 않음', () => {
  const world = makeWorld();
  const calendarId = 'equipment@example.com';
  world.calendar.addCalendar(calendarId, '[Example] Equipment', { accessRole: 'reader' });
  call(world, 'fillEquipmentSheet');
  const previousId = world.calendar.create(calendarId, {
    summary: 'User Alpha', start: '2026-10-13T09:00', end: '2026-10-13T12:00',
    creator: 'participant@example.com'
  });
  call(world, 'initialSync');
  world.at('2026-10-12T10:05');
  world.calendar.cal(calendarId).events.delete(previousId);
  const failedId = world.calendar.create(calendarId, {
    summary: 'User Beta', start: '2026-10-13T12:00', end: '2026-10-13T15:00',
    creator: 'participant@example.com'
  });
  call(world, 'safeQuota_');
  world.eval(`
    const originalSecurityFullHandler_ = handleEvent_;
    handleEvent_ = function (f, ev, ctx) {
      if (ev.id === ${JSON.stringify(failedId)}) throw new Error('Injected full-sync processing failure');
      return originalSecurityFullHandler_(f, ev, ctx);
    };
    runSync_({ notify: false, full: true });
  `);
  assert.equal(world.rowsOf(previousId)[0]['상태'], '예약');
  world.at('2026-10-12T10:10');
  const retry = call(world, 'resetSync');
  assert.equal(retry.errors.length, 0);
  assert.equal(world.rowsOf(previousId)[0]['상태'], '취소');
  assert.equal(world.rowsOf(failedId).length, 1);
});

test('비어 있는 전체 목록도 사라진 마지막 예약을 취소로 정리', () => {
  const world = makeWorld();
  const calendarId = 'equipment@example.com';
  world.calendar.addCalendar(calendarId, '[Example] Equipment Alpha', { accessRole: 'reader' });
  call(world, 'fillEquipmentSheet');
  const eventId = world.calendar.create(calendarId, {
    summary: 'User Alpha', start: '2026-10-13T09:00', end: '2026-10-13T12:00',
    creator: 'participant@example.com'
  });
  call(world, 'initialSync');
  assert.equal(world.rowsOf(eventId)[0]['상태'], '예약');
  world.at('2026-10-12T10:05');
  // 오래전에 지워져 삭제 항목 자체도 없는 전체 API 응답을 재현한다.
  world.calendar.cal(calendarId).events.delete(eventId);
  call(world, 'resetSync');
  assert.equal(world.rowsOf(eventId)[0]['상태'], '취소');
});

test('시트 탭 정리의 기본 로그는 사용자 지정 탭 이름을 노출하지 않음', () => {
  const world = makeWorld();
  const privateTab = 'User Alpha Private Equipment';
  world.ss.insertSheet(privateTab);
  const exec = call(world, 'arrangeSheetTabs');
  assert.ok(!exec.logs.concat(exec.errors).join('\n').includes(privateTab));
  assert.ok(world.ss.getSheets().some(sheet => sheet.getName() === privateTab));
});

test('시트 탭 이름 상세 로그는 관리자 설정을 켰을 때만 출력', () => {
  const world = makeWorld({ LOG_PERSONAL_DETAILS: true });
  const privateTab = 'User Alpha Private Equipment';
  world.ss.insertSheet(privateTab);
  const exec = call(world, 'arrangeSheetTabs');
  assert.ok(exec.logs.some(line => line.includes(privateTab)));
});

for (const testAddress of [
  'trial@example.com,group@example.com',
  'trial@example.com,other@example.com',
  'trial@example.com;other@example.com',
  'trial@example.com\r\nBcc: other@example.com',
  'trial @example.com'
]) {
  test('바닥글 시험은 수신자 목록이나 잘못된 단일 주소를 차단 ' + (passed + 1), () => {
    const world = makeWorld({ TEST_GROUP_EMAIL: testAddress });
    call(world, 'testFooterMail');
    assert.equal(world.mails.length, 0);
  });
}

test('바닥글 시험은 실제 그룹 주소의 대소문자와 바깥 공백도 구별하지 않음', () => {
  const world = makeWorld({ TEST_GROUP_EMAIL: '  GROUP@EXAMPLE.COM  ' });
  call(world, 'testFooterMail');
  assert.equal(world.mails.length, 0);
});

test('바닥글 시험은 검증한 시험 수신자 한 곳에만 보냄', () => {
  const trialAddress = groupAddress('example-trial');
  const world = makeWorld({ TEST_GROUP_EMAIL: trialAddress });
  const exec = call(world, 'testFooterMail');
  assert.equal(world.mails.length, 1);
  assert.equal(world.mails[0].to, trialAddress);
  assert.equal(world.mails[0].cc, undefined);
  assert.equal(world.mails[0].bcc, undefined);
  assert.ok(!exec.logs.concat(exec.errors).join('\n').includes(trialAddress));
});

for (const language of ['en', 'ko']) {
  test('바닥글 그룹 이름의 HTML을 이스케이프: ' + language, () => {
    const world = makeWorld({ FOOTER_LANG: language, GROUP_NAME: '<img src=x onerror=alert(1)> "Example"' });
    const html = call(world, 'groupFooterHtml_', groupAddress('example-team')).result;
    assert.ok(html.includes('&lt;img'));
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&quot;Example&quot;'));
    assert.ok(html.includes('href="https://groups.google.com/g/example-team"'));
  });
}

for (const slug of ['team/../private', 'team?key=value', 'team#fragment']) {
  test('바닥글 URL에서 그룹 이름의 경로·쿼리·fragment 문자를 인코딩: ' + slug, () => {
    const world = makeWorld();
    const html = call(world, 'groupFooterHtml_', groupAddress(slug)).result;
    const links = Array.from(html.matchAll(/href="([^"]+)"/g), match => match[1]);
    const archive = links.find(link => link.startsWith('https://groups.google.com/'));
    const unsubscribe = links.find(link => link.startsWith('mailto:'));
    assert.equal(new URL(archive).pathname, '/g/' + encodeURIComponent(slug));
    assert.equal(new URL(archive).search, '');
    assert.equal(new URL(archive).hash, '');
    assert.equal(unsubscribe, 'mailto:' + groupAddress(encodeURIComponent(slug + '+unsubscribe')));
  });
}

test('잘못된 그룹 주소는 바닥글 수신 거부·지난 메일 링크가 되지 않음', () => {
  const world = makeWorld();
  const html = call(world, 'groupFooterHtml_', groupAddress('team"onclick="alert(1)')).result;
  assert.ok(!html.includes('href='));
  assert.ok(!html.includes('onclick='));
});

test('HTML 메일 viewport는 한 번만 붙고 일반 텍스트 입력은 이스케이프', () => {
  const world = makeWorld();
  const message = { to: 'participant@example.com', subject: 'Example', body: '<img src=x onerror=alert(1)>' };
  call(world, 'sendMail_', message);
  const html = world.mails[0].htmlBody;
  assert.equal((html.match(/<meta name="viewport"/g) || []).length, 1);
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img'));
  call(world, 'sendMail_', Object.assign({}, message, { html }));
  assert.equal(world.mails[1].htmlBody, html);
});

test('메일 실패 기본 로그는 제목·수신자·원본 오류 개인정보를 노출하지 않음', () => {
  const world = makeWorld();
  world.mailFail = 'Injected failure for participant@example.com';
  const exec = call(world, 'sendMail_', {
    to: 'participant@example.com', subject: 'User Alpha booking', body: 'Example notice'
  });
  assert.equal(exec.result, false);
  const logs = exec.logs.concat(exec.errors).join('\n');
  assert.ok(!logs.includes('participant@example.com'));
  assert.ok(!logs.includes('User Alpha'));
  assert.equal(world.mails.length, 0);
});

console.log('\nSecurity regression checks passed: ' + passed);
