#!/usr/bin/env node
import { main } from '../src/cli.js';

main().catch((err) => {
  process.stderr.write(`agentbus: ${err.message}\n`);
  process.exitCode = 1;
});
