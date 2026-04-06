#!/usr/bin/env node

import { runCodingAgentCli } from "../run";

const exitCode = await runCodingAgentCli(process.argv.slice(2));
process.exitCode = exitCode;
