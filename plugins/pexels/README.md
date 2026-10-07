# Pexels stock footage

A NodCut plugin that finds [Pexels](https://www.pexels.com) photos and videos for B-roll: footage shown over a passage of your recording while you keep talking. It is a footage provider (`asset:footage`): `find_footage` searches and returns candidates, `get_footage` downloads the one you picked.

## Setup: your own Pexels API key

Pexels gives API keys for free, to a Pexels account, under Pexels' API terms. This plugin uses **your** key; it has no key of its own and NodCut never calls Pexels for you.

1. Sign in at [pexels.com](https://www.pexels.com), then get a key at [pexels.com/api](https://www.pexels.com/api/).
2. In NodCut: **Plugins → Pexels stock footage → Keys**, paste it into `PEXELS_API_KEY`, and press **Test key** (one small request; it downloads no media).

The key is sent to `api.pexels.com` with each request and nowhere else: no proxy, no NodCut server, no logs with the key in them.

## What leaves your computer

- **A search** sends your search words (and the kind, shape, minimum length and page you asked for) to Pexels. It returns a page of candidates with small preview images, each item's Pexels page, its creator and its licence. Nothing big is downloaded.
- **A pick** looks that one item up again on Pexels (so a removed item fails instead of downloading something else) and downloads the one file that covers your video's size from `images.pexels.com` or `videos.pexels.com`. NodCut copies it into your project, so it plays and exports offline afterwards.

Nothing is uploaded: not your video, not its audio, not its transcript.

## Credit and licence

Every item carries Pexels' licence (the [Pexels License](https://www.pexels.com/license/)) and a credit line such as "Video by Bo Example on Pexels", with links to the item and its creator. NodCut keeps them with the shot through review, undo and export and shows them in the app. Pexels asks apps to show a prominent link to Pexels and to credit creators where they can; read the current [license](https://www.pexels.com/license/) and [API documentation](https://www.pexels.com/api/documentation/) for what applies to your use.

## Limits and approval

Pexels limits how many requests a key may make per hour and per month; when the limit is used up the plugin says so with the time it resets (`E_PEXELS_RATE_LIMITED`) and does not retry. Pexels can raise the limits for an app it has reviewed; this plugin does not assume that, and its numbers are on Pexels' pages, not here (they change).

## Errors

| Code | Means | Do |
| --- | --- | --- |
| `E_PLUGIN_NEEDS_SECRET` | no key entered | enter one in Keys |
| `E_PEXELS_BAD_KEY` | Pexels refused the key | check it, or make a new one |
| `E_PEXELS_RATE_LIMITED` | the key's limit is used up | wait until it resets |
| `E_PEXELS_NOT_FOUND` | the item is gone | search again and pick another |
| `E_PEXELS_OFFLINE` | Pexels can't be reached | check the connection |
| `E_PEXELS_UNEXPECTED_HOST` | a file on a host this plugin may not use | nothing was downloaded; report it |
| `E_PEXELS_CANCELLED`, `E_PEXELS_FAILED`, `E_PEXELS_TOO_BIG`, `E_PEXELS_NO_FILE` | the download stopped or can't be done | pick it again, or another item |

## Develop

```sh
pnpm build && pnpm vitest run plugins/pexels
```

The tests run against a local HTTP stub that answers like Pexels' API, with made-up items: no key, no network, no real media.
