# Find the hidden file

On Linux, files and directories whose names start with a `.` are *hidden*. A plain `ls` doesn't show them.

Show everything, with details:

```bash
ls -la
```

Notice the `.secret` directory. Read the note inside it:

```bash
cat .secret/note.txt
```

When you don't know where a file is, `find` will search for it:

```bash
find . -name "*.md"
```
