# Start nginx

nginx is installed but not running yet. Confirm that nothing is listening:

```bash
curl -sS localhost
```

Start it. nginx forks into the background:

```bash
nginx
```

Then try again:

```bash
curl -s localhost | head -n 15
```

You should see the HTML of the default "Welcome to nginx!" page.
