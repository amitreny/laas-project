# Serve your own page

You're in `/var/www/html`, the directory nginx serves files from.

```bash
ls
```

Create an `index.html`. nginx prefers it over the default page:

```bash
echo '<h1>Hello from my lab</h1>' > index.html
curl -s localhost
```

Edit it with `nano index.html` (save with `Ctrl+O`, exit with `Ctrl+X`) and fetch it again.
