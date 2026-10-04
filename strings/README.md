# NodCut's strings

`strings.json` lists every string NodCut shows, for language packs (plugins of kind `language`): `messages` are the window's (a count by its English singular), `menu` the menu bar's labels, and `nodcut` the version they were taken from. It is written from the app's code with each change to its text, so it always matches the latest NodCut.

Check a pack against it:

```sh
pnpm nodcut-plugin validate plugins/language-ru --strings strings/strings.json
```

A string a pack lacks shows in English; the check names the ones missing. The plugin guide's "Language packs" section has the format.
