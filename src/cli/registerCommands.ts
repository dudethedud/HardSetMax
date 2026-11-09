// `npm run register-commands`: registers the slash commands by hand. Kept out of
// src/discord so the one-file bundle never runs it by accident.
import { loadEnv } from '../config/env.js';
import { registerCommands } from '../discord/registerCommands.js';
import { createLogger } from '../logger.js';

const env = loadEnv();
await registerCommands(env, createLogger(env.LOG_LEVEL));
