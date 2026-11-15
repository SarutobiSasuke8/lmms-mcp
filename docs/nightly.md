# Nightly soundtrack renders

Run `lmms-compose nightly ./recipes --out ./auditions`. Install LMMS and set
`LMMS_EXECUTABLE` if it is outside its usual location. Linux runs use Qt's
offscreen platform. The input can also be a JSON array of recipe filenames
resolved relative to that list. Each recipe uses the following minimal format.

```json
{
  "game": "forest",
  "cues": [
    { "id": "menu", "style": "ballad", "seconds": 30, "seed": 1, "count": 6, "keep": 2 }
  ]
}
```

Cue fields besides `id`, `seed`, `count` and `keep` go to `compose_batch`.
Game and cue IDs use lowercase letters, digits, hyphens and underscores.
The runner targets −16 LUFS and keeps up to four candidates for each audition
page. Open the output root's `index.html` to browse by UTC date. Each run
subfolder has a `run.json` and a page linking to its cue auditions. Download
ratings from a cue page and use `read_feedback` and `remember_taste` from an
MCP workspace rooted at that cue folder.

The default budget is 1800 seconds per recipe. Set `--budget-seconds` to
change it. Before each cue the runner checks at least 1024 MiB are available
on the output filesystem. Use `--min-free-mib` to change that threshold.
Recipe failures appear in `run.json`, remaining recipes can continue, and
the process exits non-zero if any failed. An overlapping invocation exits
immediately. After a crash, check that the prior process has stopped before
removing its stale `.nightly.lock`.

Retention is opt-in. `--keep-days 7` retains the current UTC date and previous
six dates, removing older date folders marked as owned by the runner after a
successful run. Use an output directory dedicated to the runner.

Example crontab entry, using absolute paths:

```cron
15 2 * * * /usr/local/bin/lmms-compose nightly /srv/lmms/recipes --out /srv/lmms/auditions --keep-days 14
```

Example systemd service and timer:

```ini
# lmms-nightly.service
[Service]
Type=oneshot
ExecStart=/usr/local/bin/lmms-compose nightly /srv/lmms/recipes --out /srv/lmms/auditions --keep-days 14
```

```ini
# lmms-nightly.timer
[Timer]
OnCalendar=*-*-* 02:15:00
Persistent=true

[Install]
WantedBy=timers.target
```
