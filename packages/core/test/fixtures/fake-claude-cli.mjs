#!/usr/bin/env node
// Replays a recorded `claude -p --output-format stream-json` session, so the
// adapter can be tested against output a real CLI actually produced.
// The recording to replay comes from FAKE_CLAUDE_STREAM.
import { readFileSync } from 'node:fs';

const file = process.env.FAKE_CLAUDE_STREAM;
if (!file) {
  process.stderr.write('FAKE_CLAUDE_STREAM is not set\n');
  process.exit(1);
}

// The adapter keeps stdin open and writes the prompt there; drain it so the
// pipe never fills, and never wait for it — the recording is the whole story.
process.stdin.resume();
process.stdin.on('data', () => {});

process.stdout.write(readFileSync(file, 'utf8'), () => process.exit(0));
