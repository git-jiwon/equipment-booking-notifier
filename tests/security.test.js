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

console.log('\nSecurity regression checks passed: ' + passed);
