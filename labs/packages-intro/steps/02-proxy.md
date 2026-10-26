# Where does the traffic go?

`apt` just downloaded packages from the internet. But this lab has no direct internet connection. Look at its network settings:

```bash
env | grep -i proxy
```

Every web request from this lab goes through a **proxy** called `egress-proxy`. The proxy only forwards requests to an allow-list of sites; for this lab, that's Ubuntu's package servers.

This is how lab platforms let you install software without letting a lab be used to attack other machines, send spam or mine cryptocurrency.
