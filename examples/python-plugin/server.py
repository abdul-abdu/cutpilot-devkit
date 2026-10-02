"""word-stats: a CutPilot plugin written in Python with the official MCP Python SDK.

CutPilot starts it with the manifest's command (`uv run ... server.py`) in this folder and talks
MCP over stdin/stdout. It offers one read-only extra tool, which AI clients connected to
CutPilot see as `word-stats__word_stats`. stdout belongs to MCP: log to stderr.
"""

from __future__ import annotations

import re
import sys
from collections import Counter
from typing import Annotated

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations
from pydantic import BaseModel, Field

# Words: letters (any script, so Russian and Uzbek count too), digits, and inner ' or -.
WORD = re.compile(r"[^\W_]+(?:['’-][^\W_]+)*")


class TopWord(BaseModel):
    word: str
    count: int


class WordStats(BaseModel):
    words: int = Field(description="how many words")
    unique_words: int = Field(description="how many different words, ignoring case")
    average_word_length: float = Field(description="average letters per word, to two decimals")
    top_words: list[TopWord] = Field(description="the most frequent words, most frequent first")


def word_stats(text: str, top: int = 5) -> WordStats:
    """Count the words of `text`. Pure, so it is tested without starting a server."""
    words = [w.lower() for w in WORD.findall(text)]
    counts = Counter(words)
    # most frequent first; ties in the order the words first appear
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])[:top]
    return WordStats(
        words=len(words),
        unique_words=len(counts),
        average_word_length=round(sum(len(w) for w in words) / len(words), 2) if words else 0.0,
        top_words=[TopWord(word=w, count=c) for w, c in ranked],
    )


server = MCPServer("word-stats", version="0.1.0")


@server.tool(
    name="word_stats",
    description=(
        "Word statistics for a text, such as a video's transcript: word count, unique words, "
        "average word length and the most frequent words."
    ),
    # extra tools are read-only: they never change an edit
    annotations=ToolAnnotations(read_only_hint=True),
)
def word_stats_tool(
    text: Annotated[str, Field(min_length=1, description="the text, e.g. a transcript")],
    top: Annotated[int, Field(ge=1, le=50, description="how many top words (default 5)")] = 5,
) -> WordStats:
    return word_stats(text, top)


if __name__ == "__main__":
    print("word-stats: serving on stdio", file=sys.stderr)
    server.run("stdio")
