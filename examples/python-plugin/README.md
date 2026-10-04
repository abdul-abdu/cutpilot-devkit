# Word Stats: a NodCut plugin in Python

A plugin doesn't have to be written in TypeScript. This one is Python, built with the official [MCP Python SDK](https://pypi.org/project/mcp/) (`mcp` 2.x, its `MCPServer`), and it passes the same `testPlugin()` checks as the TypeScript plugins in this repo.

It offers one read-only extra tool, `word_stats`, which AI clients connected to NodCut see as `word-stats__word_stats`: given a text (say, a video's transcript), the number of words, the number of different words, the average word length and the most frequent words.

```json
{ "words": 8, "unique_words": 5, "average_word_length": 3.25, "top_words": [{ "word": "the", "count": 3 }, { "word": "cat", "count": 2 }] }
```

## How NodCut starts it

The manifest's command is a bare name, so NodCut looks it up on PATH and runs it in this folder:

```json
"command": "uv",
"args": ["run", "--quiet", "--frozen", "server.py"]
```

[uv](https://docs.astral.sh/uv/) reads `pyproject.toml` and `uv.lock`, makes `.venv/` on the first start (downloading `mcp` from PyPI, which is why the manifest lists `pypi.org` and `files.pythonhosted.org` under `permissions.network`), and runs `server.py`, which serves MCP on stdin/stdout. Log to stderr: stdout belongs to MCP. Any language works the same way: a manifest, and a command that speaks MCP on stdio.

Users need uv installed. NodCut searches PATH and the usual package-manager folders (Homebrew's among them), so `brew install uv` is the easiest way on a Mac; uv's own installer puts it in `~/.local/bin`, which an app started from the Dock may not see.

## Run and test it

From the repository root (Node 22+, pnpm, uv):

```sh
pnpm install && pnpm build
(cd examples/python-plugin && uv sync --frozen)     # make .venv/ once
pnpm nodcut-plugin validate examples/python-plugin
pnpm nodcut-plugin test examples/python-plugin
(cd examples/python-plugin && uv run --frozen python -m unittest)   # word_stats' unit tests
```

Recorded run (uv 0.8.17, Python 3.11, mcp 2.2.0, Linux):

```
$ pnpm nodcut-plugin test examples/python-plugin
✓ manifest — word-stats 0.1.0
✓ starts and answers
✓ extra tool word_stats
word-stats: all checks passed
```

`examples/python-plugin.test.ts` runs the same check, and the unit tests, as part of `pnpm test`. It is **skipped when `uv` isn't on PATH**, so a machine without uv still passes; CI installs uv so it always runs there.

Outside this repo, with the SDK from npm: `npx -p @nodcut/plugin-sdk nodcut-plugin test .` in this folder.

## Install it in NodCut

```sh
nodcut plugin install examples/python-plugin --link   # run from this folder
nodcut plugin pack examples/python-plugin             # word-stats-0.1.0.nodcut-plugin
```

A package leaves out dot folders, so `.venv/` isn't in it: uv makes it again on the first start after an install.
