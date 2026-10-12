# Equipment Booking Notifier

[한국어 안내](README.ko.md) · [Security review](docs/SECURITY_REVIEW.md)

Google Apps Script for equipment calendars: record bookings in Google Sheets, announce late cancellations, and send a Monday briefing. No separate server is required.

All examples are fictional. Replace the `example.com` addresses with your own settings before installation.

## Features

- **Late cancellation alerts:** notify the group when a current-week booking releases time that remains available.
- **Monday briefing:** summarize bookings, overlaps, rule checks, usage, and recent late cancellations.
- **Early booking notices:** contact bookers who reserve before their week's booking window opens.
- **Booking records:** log bookings and changes without modifying calendar events.

## Installation

1. Share the equipment calendars with the administrator account.
2. Create a Google spreadsheet and open **Extensions → Apps Script**.
3. Add the seven `.gs` files from `src/` and apply `src/appsscript.json`. Enable the advanced Calendar service; a standard Google Cloud project also needs the Calendar API enabled.
4. Set the recipient addresses in `Config.gs`. Keep real configuration and credentials out of the public repository.

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

5. Run these functions in order:

| Function | Action |
|---|---|
| `setup` | Create the sheets. |
| `fillEquipmentSheet` | List calendars; mark only equipment calendars Y. |
| `checkCalendars` | Check access. |
| `previewBookerNames` | Check title parsing; enable detailed logs temporarily if needed. |
| `testMail`, `testGroupMail` | Confirm administrator and group delivery. |
| `initialSync` | Record existing bookings without notifications. |
| `installTriggers` | Start synchronization every five minutes. |

Briefings begin the following Monday. Previous-week statistics are included after a full week has been observed. If using clasp, upload only `src/`.

## Configuration

- `REPORT_CC`: additional briefing recipients.
- `DAY_LIMIT_EXEMPT`: calendar IDs exempt from the daily session limit.
- `GROUP_FOOTER`: empty by default; `'notice'` adds a compact group notice with unsubscribe and archive links for Google Groups addresses.
- `FOOTER_LANG`, `GROUP_NAME`: notice language (`en` or `ko`) and display name.
- `TEST_GROUP_EMAIL`: one separate, administrator-only group for `testFooterMail`. The test contains current booking details.
- `LOG_PERSONAL_DETAILS`: enable only when detailed diagnostics are needed.

The notice also appears in direct CC copies. Use `testFooterMail` to check its display in your mail app.

## Booking rules

Times use `Asia/Seoul`. A usage week starts Monday at 09:00; each usage day starts at 09:00.

| Type | Registration or title | Late cancellation threshold |
|---|---|---|
| Regular | Sunday 18:00 to Monday 09:00 before the usage week | Monday 09:00 |
| Additional | Monday 09:00 onward | 09:00 on the usage day |
| Early | Before that week's booking window opens | Same as regular; individual notice |
| Class | Title contains `for class` | Excluded |
| Maintenance | Title starts with `[Fix]` | Excluded; first priority in overlaps |

- Ten-minute grace period after registration.
- Regular bookings: one session per booker per day per equipment by default.
- Sessions start at 09, 12, 15, 18, 21, and 24; 24:00–09:00 is one session. Other time ranges count in three-hour units.
- Earlier registration wins overlaps; a lower-priority booker's cancellation is treated as yielding.
- Name changes before use are transfers; title changes after use are notes.
- Deleting a booking after it starts can count as a late cancellation. Keep past events.

## Sheets and everyday use

| Sheet | Purpose |
|---|---|
| `예약기록` | Booking log |
| `주간보고` | Weekly totals |
| `장비` | Equipment calendars |
| `사용자` | Names, aliases, and personal email addresses |

Bookers are read from event titles, such as `UserA (Sample)`. Combine alternate spellings in the user sheet's alias column. Its email address takes precedence over the event creator's address for personal notices.

- `previewMondayMails`: email a briefing preview to administrators.
- `resetSync`: reread calendars without notifications.
- `arrangeSheetTabs`: restore the tab order above.
- `testFooterMail`: send a notice-format briefing to the configured test group.

Allow the administrator to post to the group and set subscriptions to **Each email**. Enable notifications in your mail app; a Gmail filter such as `list:equipment-group@example.com` can help.

## Tests

Node.js is required. Tests use mocks and do not send real email.

```bash
npm test
```

To check alphabetical source loading in PowerShell:

```powershell
$env:SIM_ORDER = 'alpha'
npm test
Remove-Item Env:SIM_ORDER
```

The suites cover booking rules, synchronization, mail handling, and privacy checks.

## Privacy

Booking names and times are stored in Sheets and included in notifications. Limit spreadsheet and group access to the intended recipients. Usage statistics reflect reservations, not confirmed equipment use. See the [security review](docs/SECURITY_REVIEW.md) for the implementation checks.
