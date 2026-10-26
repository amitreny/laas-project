# Try to leave

Install `curl`. It's on the allow-listed package servers, so this works:

```bash
apt-get install -y curl
```

Now ask the proxy for a site that isn't on the list:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://example.com
```

`403`: the proxy refused. And going around the proxy doesn't work either, because there is no other way out:

```bash
curl -sS --noproxy '*' --max-time 5 http://example.com
```
