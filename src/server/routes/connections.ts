import type { FastifyInstance } from 'fastify';
import { existsSync, writeFileSync, renameSync } from 'node:fs';
import { z } from 'zod';
import { ACCOUNTS_FILE, loadConfig } from '../../config.js';
import { scrapeRunning } from '../scrapeJob.js';

const credentials = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(512),
  phoneNumber: z.string().trim().regex(/^\+[1-9]\d{7,14}$/),
}).strict();

export function connectionRoutes(app: FastifyInstance) {
  app.get('/api/connections/one-zero', async () => ({
    configured: existsSync(ACCOUNTS_FILE) && loadConfig().accounts.some(a => a.companyId === 'oneZero'),
  }));
  app.post('/api/connections/one-zero', async (req, reply) => {
    // Vite forwards requests to the API port. Compare the browser origin with
    // the configured local UI origins, rather than the proxy's Host header.
    const webPort = process.env.WEB_PORT ?? '5180';
    const allowedOrigins = [`http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`];
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) {
      return reply.code(403).send({ error: 'Cross-origin requests are not allowed' });
    }
    if (scrapeRunning()) return reply.code(409).send({ error: 'Wait for the current sync to finish' });
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter an email, password, and international phone number (for example +972501234567)' });
    const config = existsSync(ACCOUNTS_FILE) ? loadConfig() : { accounts: [] };
    const account = { companyId: 'oneZero' as const, credentials: parsed.data };
    config.accounts = [...config.accounts.filter(a => a.companyId !== 'oneZero'), account];
    const temporary = `${ACCOUNTS_FILE}.tmp`;
    writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, ACCOUNTS_FILE);
    return { configured: true };
  });
}
