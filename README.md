# Equipment Booking Notifier

[한국어 안내](README.ko.md) · [Security review](docs/SECURITY_REVIEW.md)

A Google Apps Script that reads a separate Google Calendar for each piece of equipment and creates booking records, late cancellation notifications, and Monday briefings. It runs from Google Sheets without a separate server.

**This is a public example repository.** All email addresses, booker names, organization and laboratory names, room numbers, and calendar IDs are fictional. No real operational details or local computer paths are included. Addresses at `example.com` are placeholders; replace them with your own administrator and group addresses before installation.

## Features

| Event | Recipient | Action |
|---|---|---|
| Late cancellation of a booking for the current week | Configured group | Reports the equipment, booking time, booker, and cancellation time. No notification is sent if other bookings already occupy the entire released slot. |
| First synchronization after 09:00 on Monday | Configured group | Summarizes this week's bookings, overlap priority, rule checks, last week's usage and late cancellations, and late cancellations over the last four weeks. |
| Booking made before its week's booking window opens | Individual booker | Explains when bookings open for that week and asks the booker to correct the booking. If no valid address is available, the notice goes to an administrator. |
| New booking, ordinary cancellation, change, or overlapping booking | None | Recorded in the booking log sheet. |
| Synchronization error | Administrator | Reported at most once per calendar per day. |

The script does not force changes to or deletion of calendar bookings. Overlaps and rule violations are recorded and included in briefings.

## Booking rules

All times use `Asia/Seoul`. A usage week runs from Monday at 09:00 to the following Monday at 09:00. A usage day runs from 09:00 to 09:00 the next day.

| Booking type | Registration window or condition | Late cancellation threshold |
|---|---|---|
| Regular booking | From 18:00 on the Sunday immediately before the usage week to 09:00 on Monday | Cancellation after 09:00 on Monday |
| Additional booking | Registered after 09:00 on Monday | Cancellation after 09:00 on the usage day |
| Early booking | Registered before bookings open for the usage week | Uses the regular booking threshold; the booker receives an individual notice. |
| Class booking | Title contains `for class` | Excluded from late cancellation, fulfillment rate, and rule statistics. |
| Maintenance | Title starts with `[Fix]` | Excluded from late cancellation, fulfillment rate, and rule statistics; included in overlap checks. |

- Cancellations within 10 minutes of registration receive a grace period (`GRACE_MINUTES`).
- Regular bookings are normally limited to one session per day per piece of equipment. For times that do not match session boundaries, each three hours count as one session.
- Session boundaries are 09:00, 12:00, 15:00, 18:00, 21:00, and 24:00. The period from 24:00 to 09:00 the next day is also one session.
- Earlier calendar registration has priority when bookings overlap. Maintenance has first priority. Cancellation or rescheduling of a lower-priority booking is treated as yielding the slot.
- Changing the name before the booking starts is treated as a transfer. Changing the title after the booking starts is treated as a note; the original booker and booking type are retained.
- Extending or shortening a booking while it still overlaps its original time keeps it as the same booking. Moving it to a non-overlapping time or different equipment closes the original record with a changed status.
- Deleting a booking after its start can also count as a late cancellation. Keep past events instead of deleting them.
- Recurring events are recorded for occurrences within the next 28 days. The range is extended once a day.

## Installation

1. Share the equipment calendars with the administrator account so it can read them. Set the appropriate sharing permissions if the script also needs titles of private events. The script uses the read-only Calendar OAuth scope.
2. Open a new Google spreadsheet and choose **Extensions → Apps Script**.
3. Add the seven `.gs` files from `src/` under the same names: Config, Rules, Store, Sync, Notify, Report, and Setup.
4. Enable the display of `appsscript.json` in project settings and apply `src/appsscript.json`. Confirm that the advanced Calendar service is enabled. If you have connected a standard Google Cloud project, also enable the Calendar API there.
5. **In the Apps Script editor**, replace the example addresses below with your operational addresses. Do not commit real addresses to the public repository.

```javascript
GROUP_EMAIL: 'equipment-group@example.com',
ADMIN_EMAILS: ['admin@example.com', 'admin-secondary@example.com'],
SENDER_NAME: 'Equipment Booking',
REPORT_CC: [],
DAY_LIMIT_EXEMPT: [],
LOG_PERSONAL_DETAILS: false,
```

`GROUP_EMAIL` is the address of a group you create. Remove any unused example administrator addresses. `REPORT_CC` adds briefing recipients. Add actual calendar IDs to `DAY_LIMIT_EXEMPT` only for equipment that needs an exemption from the daily limit. Enter only one email address in each individual recipient field.

6. Run the following steps in order and authorize the required permissions.

| Step | Function or action | Purpose |
|---|---|---|
| 1 | `setup` | Creates and protects the equipment, user, booking log, and weekly report sheets. |
| 2 | `fillEquipmentSheet` | Fills the equipment sheet with visible calendars. |
| 3 | Review the sheet | Calendar names starting with brackets, such as `[LAB-A] Equipment A`, are automatically marked Y for use. Mark only equipment calendars Y. |
| 4 | `checkCalendars` | Checks calendar access. |
| 5 | `previewBookerNames` | Checks names parsed from titles. Temporarily set `LOG_PERSONAL_DETAILS: true` only when detailed logs are needed. |
| 6 | `testMail` | Sends a real test email to the administrators. |
| 7 | `testGroupMail` | Sends a real test email to the group; confirm that members receive it. |
| 8 | `initialSync` | Records current bookings without notifications. |
| 9 | `installTriggers` | Installs synchronization at the default five-minute interval. |

The installation week is only partially observed, so its statistics are skipped. Briefings begin the following Monday, and previous-week statistics are included once a full week has been observed. Time-based triggers do not guarantee delivery at exactly 09:00.

If you use clasp, upload only `src/`. Do not deploy `tests/` or fixtures from older versions. Keep authentication files and project ID files out of Git as well.

## Sheets and example bookers

The script creates sheets with the following Korean names. Keep these names when using the script.

| Sheet | English meaning | Contents |
|---|---|---|
| `장비` | Equipment | Display name, calendar ID, enabled status, and access permissions. |
| `사용자` | Users | Canonical name, comma-separated aliases, and optional individual email address. |
| `예약기록` | Booking log | Registration, booking, and cancellation times; status; booker; original title; creator account; rule checks; and internal IDs. |
| `주간보고` | Weekly report | Counts of usage, cancellations, and late cancellations, plus fulfillment rates and dates. |

The booker's name is parsed from the event title. `UserA (Sample)` is read as `UserA`, and `[Equipment A] UserB` is read as `UserB`. `UserA for class - UserB` is read as a class booking for `UserB`. These are fictional examples; the Korean name-parsing examples use the fictional names `가나` and `다라`.

New names are automatically added to the user sheet. Group different spellings of the same person's name as aliases in the canonical name's row. The email in the user sheet takes precedence; if it is absent, individual mail is sent to the account that created the event. Administrator, group, and calendar accounts are not used as individual recipients. Invalid individual addresses cause the notice to be sent to an administrator instead.

The booking log is sorted by registration time in descending order. Columns are located by their headers, so you may reorder them, but **keep the column headers unchanged**. Internal ID columns are hidden. Hiding columns and protecting sheets from editing do not restrict read access.

When migrating an older sheet structure, the original is preserved in the `예약기록_백업` (booking log backup) sheet. It is also used for recovery verification; review it before deleting it. The weekly fulfillment rate is `usage / (usage + late cancellations)`. It does not measure actual equipment use.

## Administration functions

- `previewMondayMails`: Sends a real briefing email to the administrators using the current records. Email bodies are not included in the default logs.
- `protectSheets`: Reapplies edit protection to the management sheets.
- `fillUserSheet`: Adds booker names from existing records to the user sheet.
- `explainFlags`: Provides detailed diagnostics for rule violations. Detailed logs are output only when `LOG_PERSONAL_DETAILS` is enabled.
- `initialSync`: Initializes records for a newly added equipment calendar.
- `resetSync`: Rereads all calendars without notifications and reconciles them with existing records.

## Group and phone notifications

Allow the administrator account to post to the group, and set member subscriptions to **Each email** (receive every message). If a test email does not arrive, check the group's moderation queue and spam handling.

In Gmail, create a filter for your group address using a query such as `list:equipment-group@example.com`. Replace the example address with your real group address. Configure spam exceptions, importance markers, and the Primary category as needed. Also enable notifications in the mobile Gmail app and the operating system. If you use institutional email, check that service's delivery and app notification settings.

Execution and email quotas depend on the account and may change. For large groups, confirm actual delivery and the applicable limits. `safeQuota_()` checks the remaining email quota. See the [official Apps Script quotas documentation](https://developers.google.com/apps-script/guides/services/quotas) for current limits.

## Security and privacy

Anonymizing public files is separate from handling operational data. After installation, real booker names, event titles, email addresses, and calendar IDs are stored in the administrator's sheets and script properties. Group briefings and cancellation notifications also contain booker and event information. Limit sheet and group access to the people who need it, and explain the notification scope to members.

Spreadsheet editors can also change the bound Apps Script code. Keep editing access limited to the administrator account and review other users' permissions. Detailed diagnostics can write operational information to logs, so return to `LOG_PERSONAL_DETAILS: false` after troubleshooting. Manage platform-generated exception logs separately.

The code includes protections against calendar input becoming spreadsheet formulas, validation of single individual email addresses, HTML escaping, statistics handling for special names, retries for failed events, and checks of public files. The [security review](docs/SECURITY_REVIEW.md) describes the review scope.

Authentication files, private settings, real sheet exports, operational logs, and backups are excluded by `.gitignore`. Do not overwrite public files with real configuration values. Automated checks cannot identify every kind of personal information; review the files manually before publishing too.

## Tests

Only Node.js is required; no external packages need to be installed. Tests use mocks and do not send real email or call the Calendar API.

```bash
npm test
```

In PowerShell, you can also check a different file-loading order and recovery sort order:

```powershell
$env:SIM_ORDER = 'alpha'
$env:ORDER = 'oldest'
npm test
Remove-Item Env:SIM_ORDER, Env:ORDER
```

| Test | Coverage |
|---|---|
| `rules.test.js` | Week boundaries, sessions, late cancellation, title parsing, and overlap priority. |
| `sim.test.js` | Installation, synchronization, notifications, and briefing scenarios. |
| `recovery.test.js`, `recovery-extra.test.js`, `verify-v4.test.js` | Recovery of registration times and classifications from older sheets and backups. |
| `security.test.js` | Formula input, special names, recipients and headers, detailed logs, and failure retries. |
| `privacy.test.js` | Email addresses, computer paths, and common secret patterns in public files. |

Run individual tests with commands such as `node tests/rules.test.js`. Set `SIM_VERBOSE=1` to print details for passing simulation checks. Set `SIM_ONLY=3,15` to run only the selected scenarios.

## Repository structure

| File | Purpose |
|---|---|
| `src/Config.gs` | Public example configuration and booking policy. |
| `src/Rules.gs` | Booking, cancellation, overlap, and statistics rules. |
| `src/Store.gs` | Sheet storage and recovery. |
| `src/Sync.gs` | Calendar change detection and state handling. |
| `src/Notify.gs` | Notification queue, address validation, and email. |
| `src/Report.gs` | Monday briefings and weekly reports. |
| `src/Setup.gs` | Installation, access checks, triggers, and diagnostics. |
| `src/appsscript.json` | Permissions for reading calendars, accessing the current spreadsheet, sending email, and managing triggers. |
| `tests/fixtures/src-v3/` | Anonymized recovery fixtures from an older version. Do not deploy them. |

## Limitations

- The Calendar API does not identify who deleted an event. The booker is inferred from the title.
- Calendar data alone cannot determine whether equipment was actually used.
- If a deleted event has no modification time, the script uses the previous synchronization time or other fallback information to classify it conservatively.
- Converting a timed event to an all-day event is treated as a booking cancellation.
- Failed emails are retried on the next synchronization. Pending notifications are removed once the slot has passed or they have waited for 24 hours.
- If calendar reads fail on Monday, the briefing is delayed by up to 30 minutes. After that, the briefing may omit calendars that could not be read.
- Mock tests do not guarantee real service permissions, quotas, or email delivery. Confirm administrator and group test emails after installation.
