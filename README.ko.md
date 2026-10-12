# 장비 예약 알림 · Equipment Booking Notifier

[English](README.md) · [보안 점검 기록](docs/SECURITY_REVIEW.ko.md)

장비별 캘린더의 예약을 Google Sheets에 기록하고, 직전 취소 알림과 월요일 브리핑을 보내는 Google Apps Script입니다. 별도 서버가 필요하지 않습니다.

모든 예시는 가상 값입니다. 설치 전에 `example.com` 주소를 본인의 설정으로 바꾸세요.

## 주요 기능

- **직전 취소 알림:** 이번 주 예약이 취소되어 사용 가능한 시간이 생기면 그룹에 안내합니다.
- **월요일 브리핑:** 예약, 중복, 규칙 확인, 사용 기록과 최근 직전 취소를 요약합니다.
- **기간전예약 안내:** 해당 주 예약이 열리기 전에 예약한 사람에게 개인 메일을 보냅니다.
- **예약 기록:** 캘린더 일정을 수정하지 않고 예약과 변경을 기록합니다.

## 설치

1. 관리 계정에 장비 캘린더를 공유합니다.
2. Google 스프레드시트를 만들고 **확장 프로그램 → Apps Script**를 엽니다.
3. `src/`의 `.gs` 파일 7개와 `src/appsscript.json`을 적용합니다. Calendar 고급 서비스를 켜고, 표준 Google Cloud 프로젝트를 쓰면 Calendar API도 활성화합니다.
4. `Config.gs`의 수신 주소를 설정합니다. 실제 설정과 인증 정보는 공개 저장소에 넣지 마세요.

```javascript
GROUP_EMAIL: 'equipment-group@example.com',
ADMIN_EMAILS: ['admin@example.com', 'admin-secondary@example.com'],
SENDER_NAME: 'Equipment Booking',
REPORT_CC: [],
DAY_LIMIT_EXEMPT: [],
LOG_PERSONAL_DETAILS: false,
GROUP_FOOTER: '',
FOOTER_LANG: 'en',
TEST_GROUP_EMAIL: '',
GROUP_NAME: 'Example Equipment Group',
```

5. 다음 함수를 순서대로 실행합니다.

| 함수 | 내용 |
|---|---|
| `setup` | 시트 생성 |
| `fillEquipmentSheet` | 캘린더 목록을 채우고 장비 캘린더만 Y로 지정 |
| `checkCalendars` | 접근 권한 확인 |
| `previewBookerNames` | 제목에서 읽은 이름 확인. 필요할 때만 상세 로그를 잠시 켬 |
| `testMail`, `testGroupMail` | 관리자·그룹 메일 수신 확인 |
| `initialSync` | 기존 예약을 알림 없이 기록 |
| `installTriggers` | 5분 간격 동기화 시작 |

다음 월요일부터 브리핑을 시작하며, 온전한 한 주를 관측한 뒤 지난주 통계를 포함합니다. clasp를 쓰면 `src/`만 업로드하세요.

## 설정

- `REPORT_CC`: 브리핑 추가 수신자
- `DAY_LIMIT_EXEMPT`: 하루 세션 제한에서 제외할 캘린더 ID
- `GROUP_FOOTER`: 기본은 빈 값. `'notice'`로 켜면 Google Groups 주소에 수신 거부·지난 메일 링크가 담긴 작은 안내를 붙임
- `FOOTER_LANG`, `GROUP_NAME`: 안내 언어(`en` 또는 `ko`)와 표시 이름
- `TEST_GROUP_EMAIL`: `testFooterMail`에 사용할 관리자 전용 시험 그룹 주소 한 개. 시험 메일에는 현재 예약 정보가 포함됨
- `LOG_PERSONAL_DETAILS`: 상세 진단이 필요할 때만 켬

안내는 직접 참조(CC)로 받는 메일에도 보입니다. `testFooterMail`로 사용하는 메일 앱의 표시를 확인하세요.

## 예약 규칙

시간은 `Asia/Seoul` 기준입니다. 사용 주는 월요일 09:00, 사용일은 매일 09:00에 시작합니다.

| 구분 | 등록 조건 또는 제목 | 직전 취소 기준 |
|---|---|---|
| 정기예약 | 해당 주 직전 일요일 18:00 ~ 월요일 09:00 | 월요일 09:00 |
| 추가예약 | 월요일 09:00 이후 | 사용일 09:00 |
| 기간전예약 | 해당 주 예약이 열리기 전 | 정기예약과 같음, 개인 안내 |
| 수업예약 | 제목에 `for class` 포함 | 제외 |
| 점검 | 제목이 `[Fix]`로 시작 | 제외, 중복에서는 1순위 |

- 등록 후 10분 안의 취소는 유예합니다.
- 정기예약은 기본적으로 예약자별·장비별 하루 1세션입니다.
- 세션은 09·12·15·18·21·24시에 시작하며 24:00–09:00도 한 세션입니다. 그 밖의 시간은 3시간 단위로 셉니다.
- 먼저 등록한 예약이 우선이며 후순위 예약자의 취소는 양보로 봅니다.
- 사용 전 이름 변경은 양도, 사용 후 제목 변경은 메모로 봅니다.
- 사용 시작 뒤 삭제도 직전 취소가 될 수 있으므로 지난 일정은 남겨 두세요.

## 시트와 사용

| 시트 | 용도 |
|---|---|
| `예약기록` | 예약 기록 |
| `주간보고` | 주간 통계 |
| `장비` | 장비 캘린더 |
| `사용자` | 이름·별칭·개인 이메일 |

예약자는 `UserA (Sample)`처럼 일정 제목에서 읽습니다. 같은 사람의 다른 표기는 사용자 시트의 별칭에 묶습니다. 개인 알림은 사용자 시트의 이메일을 우선 사용하고 없으면 일정을 만든 계정으로 보냅니다.

- `previewMondayMails`: 관리자에게 브리핑 미리보기 발송
- `resetSync`: 알림 없이 캘린더 다시 읽기
- `arrangeSheetTabs`: 위 순서로 시트 탭 정리
- `testFooterMail`: 설정한 시험 그룹에 안내 형식 브리핑 발송

관리 계정의 그룹 게시를 허용하고 구독을 **모든 이메일**로 설정하세요. 메일 앱 알림도 켭니다. Gmail에서는 `list:equipment-group@example.com` 같은 필터를 사용할 수 있습니다.

## 테스트

Node.js가 필요합니다. 모의 환경에서 실행하며 실제 메일을 보내지 않습니다.

```bash
npm test
```

PowerShell에서 소스 파일을 이름순으로 읽는 경우도 확인할 수 있습니다.

```powershell
$env:SIM_ORDER = 'alpha'
npm test
Remove-Item Env:SIM_ORDER
```

예약 규칙, 동기화, 메일 처리, 개인정보 검사를 포함합니다.

## 개인정보

예약자와 시간은 시트에 저장되고 알림에도 포함됩니다. 시트와 그룹은 필요한 수신자에게만 공유하세요. 사용 통계는 실제 장비 사용 확인이 아닌 예약 기준입니다. 구현 점검 내용은 [보안 점검 기록](docs/SECURITY_REVIEW.ko.md)에 있습니다.
