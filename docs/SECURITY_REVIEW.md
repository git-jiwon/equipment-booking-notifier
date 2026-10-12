# Public release security and privacy review

[한국어](SECURITY_REVIEW.ko.md) · [User guide](../README.md)

Public source, tests, and documentation use fictional addresses, users, equipment, and calendar IDs. Credentials, operational logs, exports, and backups are excluded.

## Implemented protections

- Escape formula prefixes in external spreadsheet text and dynamic text in email HTML.
- Use objects without a prototype for statistics and calendar grouping to avoid special-key collisions.
- Require one personal email address, route invalid addresses to an administrator, and reject line breaks in mail headers.
- Require one `TEST_GROUP_EMAIL` address and reject the live group address in `testFooterMail`.
- Validate group addresses and encode unsubscribe and archive links; escape the displayed group name.
- Enable personal details in application logs only with `LOG_PERSONAL_DETAILS: true`.
- Preserve the previous sync token and successful sync time after processing failures so the next run retries; reconcile cancellations even after a successful full read returns no events.

## Permissions

The manifest uses four scopes under `https://www.googleapis.com/auth/`: `calendar.readonly`, `spreadsheets.currentonly`, `script.send_mail`, and `script.scriptapp` (Calendar reading, the current spreadsheet, email sending, and trigger management).

## Validation

Run `npm test`, then repeat with `SIM_ORDER=alpha`. Checks cover rules, simulation, formula/HTML escaping, address and header validation, footer destinations and links, logging, sync retries, and public-file privacy.

## Deployment checks

Real deployments store and send booking information. Limit spreadsheet access and group/archive membership, including the test group: `testFooterMail` includes current bookings. Detailed or platform exception logs may also retain operational data.

Tests use simulated Google services. Check permissions, email delivery, and footer rendering after installation; Google Groups and mail apps may rewrite the footer HTML.
