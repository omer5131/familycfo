import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connectionRoutes } from '../src/server/routes/connections.js';

const file = vi.hoisted(() => `/private/tmp/familycfo-connection-test-${Date.now()}.json`);
vi.mock('../src/config.js', () => ({
  ACCOUNTS_FILE: file,
  loadConfig: () => JSON.parse(readFileSync(file, 'utf8')),
}));
vi.mock('../src/server/scrapeJob.js', () => ({ scrapeRunning: () => false }));
afterEach(() => { rmSync(file, { force: true }); rmSync(`${file}.tmp`, { force: true }); });
const payload = { email: 'test@example.com', password: 'test-only', phoneNumber: '+972501234567' };
function setup() { const app = Fastify(); connectionRoutes(app); return app; }

describe('multiple Isracard logins', () => {
  const first = { id: '000000001', card6Digits: '123456', password: 'test-only' };
  it('adds separate logins, updates the same login, and never returns credentials', async () => {
    const app = setup();
    writeFileSync(file, JSON.stringify({ accounts: [{ companyId: 'leumi', credentials: { username: 'test' } }], categoryApiUrl: 'http://localhost/test' }));
    expect((await app.inject({ method: 'POST', url: '/api/connections/isracard', payload: first })).json()).toEqual({ count: 1 });
    expect((await app.inject({ method: 'POST', url: '/api/connections/isracard', payload: { ...first, id: '000000002' } })).json()).toEqual({ count: 2 });
    expect((await app.inject({ method: 'POST', url: '/api/connections/isracard', payload: { ...first, card6Digits: '654321' } })).json()).toEqual({ count: 3 });
    expect((await app.inject({ method: 'POST', url: '/api/connections/isracard', payload: { ...first, password: 'updated-test-only' } })).json()).toEqual({ count: 3 });
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.accounts).toHaveLength(4);
    expect(saved.accounts[0].companyId).toBe('leumi');
    expect(saved.accounts[1].credentials.password).toBe('updated-test-only');
    expect(saved.categoryApiUrl).toBe('http://localhost/test');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect((await app.inject('/api/connections/isracard')).json()).toEqual({ count: 3 });
    await app.close();
  });
  it('rejects invalid credentials and untrusted origins without writing', async () => {
    const app = setup();
    for (const payload of [{ ...first, id: '1' }, { ...first, card6Digits: '123' }, { ...first, password: '' }]) {
      expect((await app.inject({ method: 'POST', url: '/api/connections/isracard', payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/api/connections/isracard', payload: first, headers: { origin: 'https://example.com' } })).statusCode).toBe(403);
    expect(existsSync(file)).toBe(false);
    await app.close();
  });
});

describe('ONE ZERO setup', () => {
  it.each(['http://127.0.0.1:5180', 'http://localhost:5180'])('accepts the local UI origin %s through the API proxy', async origin => {
    const app = setup();
    const result = await app.inject({ method: 'POST', url: '/api/connections/one-zero',
      headers: { origin, host: '127.0.0.1:4310' }, payload });
    expect(result.statusCode).toBe(200);
    await app.close();
  });
  it.each(['null', 'http://127.0.0.1:9999', 'http://localhost.attacker.example:5180'])('rejects untrusted origin %s', async origin => {
    const app = setup();
    expect((await app.inject({ method: 'POST', url: '/api/connections/one-zero', headers: { origin }, payload })).statusCode).toBe(403);
    expect(existsSync(file)).toBe(false);
    await app.close();
  });
  it('preserves other banks and returns no credentials, with owner-only storage', async () => {
    const app = setup();
    writeFileSync(file, JSON.stringify({ accounts: [{ companyId: 'leumi', credentials: { username: 'test' } }] }));
    const result = await app.inject({ method: 'POST', url: '/api/connections/one-zero', payload });
    expect(result.json()).toEqual({ configured: true });
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.accounts.map((a: { companyId: string }) => a.companyId)).toEqual(['leumi', 'oneZero']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect((await app.inject('/api/connections/one-zero')).json()).toEqual({ configured: true });
    await app.close();
  });
  it('rejects invalid phone numbers and cross-origin writes without storing credentials', async () => {
    const app = setup();
    expect((await app.inject({ method: 'POST', url: '/api/connections/one-zero', payload: { ...payload, phoneNumber: '0501234567' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/connections/one-zero', headers: { origin: 'https://example.com' }, payload })).statusCode).toBe(403);
    expect(existsSync(file)).toBe(false);
    await app.close();
  });
});
