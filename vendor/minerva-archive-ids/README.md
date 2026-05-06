# Vendored Minerva archive IDs

This directory is intended to mirror:
- https://github.com/yeetbot90/Minerva-archive-ids

The app first attempts to read local `markdown-files/*-ids.md` mappings from this folder,
then falls back to remote raw GitHub URLs if local maps are missing.

To sync from upstream, run:

```bash
npm run sync:minerva-ids
```

If your environment blocks GitHub access, run the command on a machine with network access
and commit the resulting `vendor/minerva-archive-ids/markdown-files/` contents.
