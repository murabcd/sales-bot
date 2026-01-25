---
summary: "Daily Jira status report (cron)"
read_when:
  - You want an automated daily status report in Telegram
---
# Daily status report (cron)

Omni can post a daily Jira status report to a Telegram chat using Cloudflare
Worker Cron Triggers. The report is split by teams and includes:

- Прогресс за вчера
- Сейчас в работе
- Блокеры/риски

## Scheduling

The cron trigger is configured in `worker/wrangler.toml` and uses **UTC**.
For 11:00 Moscow time (UTC+3) on weekdays:

```
0 8 * * 1-5
```

## Environment variables

Set these in the Cloudflare dashboard (or `.env` locally):

```
CRON_STATUS_ENABLED=1
CRON_STATUS_CHAT_ID=-1002020976796
CRON_STATUS_TIMEZONE=Europe/Moscow
CRON_STATUS_MAX_ITEMS_PER_SECTION=0
CRON_STATUS_SPRINT_FILTER=open
CRON_STATUS_SPRINT_CLAUSE=
CRON_STATUS_SUMMARY_ENABLED=0
CRON_STATUS_SUMMARY_MODEL=
CRON_STATUS_IN_PROGRESS_STATUSES=
CRON_STATUS_BLOCKED_STATUSES=
CRON_TEAM_AI_ASSIGNEES=Vitaly Zadorozhny
CRON_TEAM_CS_ASSIGNEES=Mikhail Shpakov,Dmitrii Pletnev,Andrey Pozdnyshev
CRON_TEAM_HR_ASSIGNEES=Dmitry Zorin,Ponosov Alexandr
```

If `CRON_STATUS_IN_PROGRESS_STATUSES` or `CRON_STATUS_BLOCKED_STATUSES` are
empty, Omni uses safe defaults.

## Jira requirements

Jira API credentials must be configured:

- `JIRA_BASE_URL`
- `JIRA_EMAIL`
- `JIRA_API_TOKEN`
- `JIRA_PROJECT_KEY`

## Notes

- Team member names must match Jira assignee display names.
- The report is generated in Russian.
- Sprint filtering defaults to `sprint in openSprints()`. Set
  `CRON_STATUS_SPRINT_FILTER=off` to disable or `CRON_STATUS_SPRINT_CLAUSE`
  for a custom JQL sprint filter.
- Enable AI summaries with `CRON_STATUS_SUMMARY_ENABLED=1` (requires
  `OPENAI_API_KEY`).
