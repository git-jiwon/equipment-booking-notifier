# Public release security and privacy review

[한국어](SECURITY_REVIEW.ko.md) · [User guide](../README.md)

This review covers the Google Apps Script source, tests and older-version fixtures, README, and repository publication settings. Public files use fictional email addresses, users, equipment, lab labels, and calendar IDs. Local computer paths, institution domains, specific operational incident records, and original backups are excluded from publication.

## Changes applied

| Issue | Mitigation |
|---|---|
| Spreadsheet formula injection through calendar names | Escape formula prefixes before writing external text to Sheets. Apply the same protection to every text field in reservation records. |
| Special user names or calendar IDs colliding with object keys | Use objects without a prototype for statistics and calendar grouping so keys such as `constructor` and `__proto__` are handled as independent values. |
| Extra recipients injected into a personal notification | Require one email address for each personal recipient. Route an invalid personal address to an administrator notification. |
| Mail header format | Validate recipient syntax and reject line breaks in recipient lists, subjects, and sender display names. |
| Personal information in application logs | Log original names, addresses, message bodies, and event identifiers only when `LOG_PERSONAL_DETAILS: true` is explicitly enabled. |
| Failed events skipped by incremental synchronization | Keep that calendar's previous sync token and last successful synchronization time after event processing fails, allowing the next run to retry. |
| Publication content and configuration | Anonymize the README and fixtures, exclude credentials, exports, logs, and backups, and scan public files for common identifiers and secrets. |

Dynamic text in email HTML is escaped. The manifest uses read-only Calendar access, the current spreadsheet, email sending, and trigger management scopes. It does not add permission for external HTTP requests.

## Validation

Run `npm test` for the rule, simulation, recovery, security, and public-file checks. Additional runs verify alternate source loading and backup sorting orders. Security regression checks cover malicious inputs at the spreadsheet and mail boundaries, detailed logging settings, and retry after processing failures. Tests do not call live Google services.

The first published commit contains only anonymized files and uses a fictional author and committer name and email. The original folder had no Git repository, so no historical records containing the original personal information were imported. Original backups and local review records remain outside the repository.

## Operational personal information and review limits

After real deployment, Sheets and script properties store user names, schedules, email addresses, and internal IDs. Notifications and group briefings also share booking information. Enabling detailed logs or allowing platform exception logging may retain operational data. Operators must manage editing and viewing permissions, group membership and archive access, and data retention and deletion policies.

Sheet protection and hidden columns do not restrict viewing access. Pattern checks cannot identify every real name or institution. This review covers source code and simulated execution; it does not validate live service permissions, account security, actual email delivery, or every Google platform exception path. Historical source fixtures are anonymized, but the current security fixes apply to the production `src/` files. Do not deploy the fixtures.

GitHub displays the publishing account and its profile. Content anonymization does not anonymize the account itself.

## References

- [Google Apps Script Range.setValues](https://developers.google.com/apps-script/reference/spreadsheet/range#setValues(Object)): values beginning with `=` are interpreted as formulas.
- [Google Apps Script MailApp](https://developers.google.com/apps-script/reference/mail/mail-app): recipient lists and message options.
- [Apps Script OAuth scopes](https://developers.google.com/apps-script/concepts/scopes): permissions in the manifest.
