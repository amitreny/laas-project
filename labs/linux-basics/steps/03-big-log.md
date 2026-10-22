# Read a big log

`app.log` has 500 lines, which is too many to `cat`. Count them first:

```bash
wc -l app.log
```

Peek at the start and the end:

```bash
head -n 5 app.log
tail -n 5 app.log
```

Now find only the errors:

```bash
grep ERROR app.log
```

**Challenge:** how many errors are there? Pipe `grep` into `wc -l` to count them.
