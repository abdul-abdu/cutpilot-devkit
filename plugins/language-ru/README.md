# Русский — Russian

NodCut's interface in Russian (Русский): every screen, message and menu. Install it from the plugin store, then pick **Русский** in **Settings ▸ General ▸ Interface language** (or leave it on *Same as the system* with your Mac set to Russian). It changes at once, menus included.

It is a language pack: two files of translations, nothing that runs. It asks for no permissions and never starts a process.

| File | What |
| --- | --- |
| `ru.json` | the window's strings, keyed by the English text |
| `ru.menu.json` | the menu bar's labels |

A string the pack doesn't have yet shows in English. To fix or add a translation, edit the file and check it against the strings NodCut shows:

```sh
pnpm nodcut-plugin validate plugins/language-ru --strings strings/strings.json
```

The format and the rules are in the plugin guide, under "Language packs".
