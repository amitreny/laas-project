# Read the logs

Every request is written to the access log:

```bash
tail -n 5 /var/log/nginx/access.log
```

Ask for a page that doesn't exist and watch the `404` arrive:

```bash
curl -s -o /dev/null -w "%{http_code}\n" localhost/nope
tail -n 1 /var/log/nginx/access.log
```

> Later (Phase 7) the platform will let you open this server in your own browser tab.
