#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for Bash (.claude/settings.json): the git rules of AGENTS.md,
 * enforced rather than remembered. Reads the tool call as JSON on stdin and answers with a
 * permission decision: `deny` for a commit message with an AI attribution line or a
 * `--no-verify`, `ask` for anything that leaves this machine or rewrites history.
 */
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const cmd = String(input?.tool_input?.command ?? '');

const decide = (permissionDecision, permissionDecisionReason) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason },
    }),
  );
  process.exit(0);
};

const commits = /\bgit\b[^\n|;&]*\bcommit\b/.test(cmd);
if (commits && /Co-Authored-By|Generated with \[Claude|🤖/i.test(cmd))
  decide(
    'deny',
    'AGENTS.md: no Co-Authored-By or other AI attribution line in commit messages. Commit again without it.',
  );
if (/\bgit\b[^\n|;&]*\b(commit|push)\b[^\n|;&]*--no-verify/.test(cmd))
  decide('deny', 'AGENTS.md: never --no-verify. Fix what the hook reports instead.');

const asks = [
  [/\bgit\b[^\n|;&]*\bpush\b/, 'pushing'],
  [/\bgit\b[^\n|;&]*\b(merge|rebase)\b/, 'merging or rebasing'],
  [/\bgit\b[^\n|;&]*\bcommit\b[^\n|;&]*--amend/, 'amending a commit'],
  [/\bgit\b[^\n|;&]*--force/, 'forcing a git operation'],
  [/\bgh\b[^\n|;&]*\bpr\b[^\n|;&]*\b(create|merge)\b/, 'opening or merging a PR'],
  [/\b(npm|pnpm)\b[^\n|;&]*\bpublish\b/, 'publishing to npm'],
];
for (const [re, what] of asks)
  if (re.test(cmd)) decide('ask', `AGENTS.md: ${what} only when the user asked. Confirm this was asked for.`);
