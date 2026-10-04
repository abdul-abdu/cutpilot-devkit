# O'zbekcha — Uzbek

CutPilot's interface in Uzbek, Latin script (O'zbekcha): every screen, message and menu. Install it from the plugin store, then pick **O'zbekcha** in **Settings ▸ General ▸ Interface language** (or leave it on *Same as the system* with your Mac set to Uzbek). It changes at once, menus included.

It is a language pack: two files of translations, nothing that runs. It asks for no permissions and never starts a process.

| File | What |
| --- | --- |
| `uz.json` | the window's strings, keyed by the English text |
| `uz.menu.json` | the menu bar's labels |

A string the pack doesn't have yet shows in English. To fix or add a translation, edit the file and check it against the strings CutPilot shows:

```sh
pnpm cutpilot-plugin validate plugins/language-uz --strings strings/strings.json
```

The format and the rules are in the plugin guide, under "Language packs".
