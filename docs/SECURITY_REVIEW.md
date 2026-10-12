# Public release security and privacy review

[한국어](SECURITY_REVIEW.ko.md) · [User guide](../README.md)

This review covers the Google Apps Script source, tests, README, and repository publication settings. Public files use fictional email addresses, users, equipment, lab labels, and calendar IDs. Local computer paths, institution domains, specific operational incident records, and original backups are excluded from publication.

## Changes applied

| Issue | Mitigation |
|---|---|
| Spreadsheet formula injection through calendar names | Escape formula prefixes before writing external text to Sheets. Apply the same protection to every text field in reservation records. |
| Special user names or calendar IDs colliding with object keys | Use objects without a prototype for statistics and calendar grouping so keys such as `constructor` and `__proto__` are handled as independent values. |
| Extra recipients injected into a personal notification | Require one email address for each personal recipient. Route an invalid personal address to an administrator notification. |
| Mail header format | Validate recipient syntax and reject line breaks in recipient lists, subjects, and sender display names. |
| Footer test reaching the live group through an address list | Require one address for `TEST_GROUP_EMAIL` and reject the live group address. The test uses current booking details, so its group membership and archive access must be restricted to authorized administrators. |
| Group footer links derived from an email address | Validate the group address before generating unsubscribe and archive links, and encode the group name used in URLs. Unsupported addresses receive a manager-contact notice. Escape the configured display name. |
| Personal information in application logs | Log original names, addresses, message bodies, event identifiers, and custom sheet names only when `LOG_PERSONAL_DETAILS: true` is explicitly enabled. |
| Failed events skipped by incremental synchronization | Keep that calendar's previous sync token and last successful synchronization time after event processing fails, allowing the next run to retry. |
| Last booking omitted from deletion checks after an empty full-calendar response | Reconcile previously recorded active bookings even when a successful full read returns no events. |
| Publication content and configuration | Anonymize the README and tests, exclude credentials, exports, logs, and backups, and scan public files for common identifiers and secrets. |

Dynamic text in email HTML is escaped. The manifest uses read-only Calendar access, the current spreadsheet, email sending, and trigger management scopes. It does not add permission for external HTTP requests.

## Validation

Run `npm test` for the rule, simulation, security, and public-file checks, then repeat with `SIM_ORDER=alpha` for an alternate source loading order. Security regression checks cover malicious inputs at the spreadsheet and mail boundaries, detailed logging settings, and retry after processing failures. Simulation checks cover the optional weekly sheet, tab ordering, footer mail, and cancellation reconciliation. Tests do not call live Google services.

The first published commit contains only anonymized files and uses a fictional author and committer name and email. The original folder had no Git repository, so no historical records containing the original personal information were imported. Original backups and local review records remain outside the repository.

## Operational personal information and review limits

After real deployment, Sheets and script properties store user names, schedules, email addresses, and internal IDs. Notifications and group briefings also share booking information. Enabling detailed logs or allowing platform exception logging may retain operational data. Operators must manage editing and viewing permissions, group membership and archive access, and data retention and deletion policies.

The notice footer is included in mail sent directly to CC recipients as well as group members. Its wording and unsubscribe link describe group membership, which may not apply to direct CC recipients. `testFooterMail` sends current booking details to the configured test group, rather than synthetic data. Default `GROUP_FOOTER: ''` preserves the existing footer behavior. The optional notice uses HTML styling intended to hide the standard Groups footer; Google Groups or email apps may rewrite it. This review does not verify live footer rendering in Google Groups, Samsung Email, or other mail apps.

Sheet protection and hidden columns do not restrict viewing access. Pattern checks cannot identify every real name or institution. This review covers source code and simulated execution; it does not validate live service permissions, account security, actual email delivery, or every Google platform exception path.

GitHub displays the publishing account and its profile. Content anonymization does not anonymize the account itself.

## References

- [Google Apps Script Range.setValues](https://developers.google.com/apps-script/reference/spreadsheet/range#setValues(Object)): values beginning with `=` are interpreted as formulas.
- [Google Apps Script MailApp](https://developers.google.com/apps-script/reference/mail/mail-app): recipient lists and message options.
- [Apps Script OAuth scopes](https://developers.google.com/apps-script/concepts/scopes): permissions in the manifest.
- [Google Groups settings](https://support.google.com/groups/answer/2464926?hl=en): standard and custom email footer settings; check these before enabling the optional notice.
