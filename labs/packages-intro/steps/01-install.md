# Install a package

Ubuntu installs software with `apt`. First refresh the list of available packages:

```bash
apt-get update
```

Then install `cowsay`, a classic:

```bash
apt-get install -y cowsay
```

And try it:

```bash
/usr/games/cowsay "Hello from my lab"
```
