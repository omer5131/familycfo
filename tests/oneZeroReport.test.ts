import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { openDb, type DB } from '../src/db/connection.js';
import { parseOneZeroPages, saveOneZeroReport, type ReportText } from '../src/import/oneZeroReport.js';
import { transactionImportRoutes } from '../src/server/routes/transactionImports.js';
import { insuranceRoutes } from '../src/server/routes/insurance.js';
import { transactionRoutes } from '../src/server/routes/transactions.js';
import { runPipeline } from '../src/pipeline.js';

vi.mock('../src/import/oneZeroReport.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/import/oneZeroReport.js')>();
  return { ...original, readOneZeroPdf: vi.fn(async () => original.parseOneZeroPages(fixture())) };
});
const text = (str: string, x: number, y: number): ReportText => ({ str, x, y, w: 20 });
function fixture(): ReportText[][] {
  return [[
    text('ONE ZERO Digital Bank LTD', 409, 774), text('תנועות שקליות', 107, 736),
    text('סניף •123456789', 392, 789), text('01/04/2026 - 30/04/2026', 285, 714),
    ...[['יתרה קודמת', '100', 605], ['סך כל החיובים', '20', 591], ['סך כל הזיכויים', '5', 577], ['יתרה חדשה', '85', 564]]
      .flatMap(([label, amount, y]) => [text(String(label), 470, Number(y)), text(String(amount), 351, Number(y))]),
    ...[500, 470, 440].flatMap((y, i) => [
      text('12/04/2026', 480, y), text(i === 2 ? '11/04/2026' : '12/04/2026', 408, y),
      text(i === 2 ? '0 ש״ח' : '10 ש״ח', 260, y), text(i === 2 ? '5 ש״ח' : '0 ש״ח', 174, y),
      text(`${[90, 80, 85][i]} ש״ח`, 70, y), text(i === 2 ? 'החזר' : 'חנות', 320, y + 6), text('פעולה', 350, y - 6),
    ]),
  ]];
}
let db: DB | undefined;
afterEach(() => { db?.close(); db = undefined; vi.clearAllMocks(); });

describe('ONE ZERO report import', () => {
  it('edits imported categories through the shared API and preserves edits after reimport and processing', async () => {
    db = openDb(':memory:');
    const app = Fastify();
    transactionRoutes(app, db);
    const report = parseOneZeroPages(fixture());
    saveOneZeroReport(db, report);
    await runPipeline(db, { fetchRates: false });
    const rows = (await app.inject({ url: '/api/transactions' })).json().rows as { id: number; amount: number }[];
    const ids = rows.filter(t => t.amount < 0).map(t => t.id);
    const categoryId = Number(db.prepare("INSERT INTO categories (name, kind) VALUES ('PDF savings test', 'savings')").run().lastInsertRowid);
    const edited = await app.inject({ method: 'PATCH', url: `/api/transactions/${ids[0]}`, payload: { categoryId } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ categoryId, categorySource: 'manual', kind: 'savings' });
    const bulk = await app.inject({ method: 'POST', url: '/api/transactions/bulk', payload: { ids, patch: { categoryId } } });
    expect(bulk.statusCode).toBe(200);
    saveOneZeroReport(db, report);
    await runPipeline(db, { fetchRates: false });
    const listed = (await app.inject({ url: `/api/transactions?category=${categoryId}` })).json();
    expect(listed.rows).toHaveLength(2);
    expect(listed.totals.spend).toBe(0);
    for (const row of listed.rows) expect(row).toMatchObject({ categoryId, categorySource: 'manual', kind: 'savings' });
    // An explicit transaction type must still take priority over the category.
    await app.inject({ method: 'PATCH', url: `/api/transactions/${ids[0]}`, payload: { kind: 'expense', categoryId: null } });
    saveOneZeroReport(db, report);
    await runPipeline(db, { fetchRates: false });
    const cleared = (await app.inject({ url: '/api/transactions' })).json().rows.find((t: { id: number }) => t.id === ids[0]);
    expect(cleared).toMatchObject({ categoryId: null, categorySource: 'manual', kind: 'expense' });
    await app.close();
  });
  it('parses debit signs, value dates, and multiline Hebrew descriptions', () => {
    const report = parseOneZeroPages(fixture());
    expect(report.transactions.map(t => t.chargedAmount)).toEqual([-10, -10, 5]);
    expect(report.transactions[0].description).toBe('חנות פעולה');
    expect(report.transactions[2].processedDate).toBe('2026-04-11');
    expect(report.closingBalance).toBe(85);
  });
  it('rejects missing rows, bad totals, running balances, invalid dates, and other layouts', () => {
    for (const change of [
      (p: ReportText[]) => { p.splice(p.findIndex(t => t.x === 260 && t.y === 470), 1); },
      (p: ReportText[]) => { p.find(t => t.x === 351 && t.y === 591)!.str = '21'; },
      (p: ReportText[]) => { p.find(t => t.x === 70 && t.y === 470)!.str = '79'; },
      (p: ReportText[]) => { p.find(t => t.x === 480 && t.y === 470)!.str = '31/04/2026'; },
      (p: ReportText[]) => { p[0].str = 'Other Bank'; },
    ]) {
      const pages = fixture(); change(pages[0]); expect(() => parseOneZeroPages(pages)).toThrow();
    }
  });
  it('keeps identical payments, deduplicates repeated and overlapping reports, and preserves manual edits', () => {
    db = openDb(':memory:');
    const report = parseOneZeroPages(fixture());
    expect(saveOneZeroReport(db, report).inserted).toBe(3);
    const row = db.prepare('SELECT id FROM transactions ORDER BY id LIMIT 1').get() as { id: number };
    db.prepare("UPDATE transactions SET kind = 'transfer', kind_source = 'manual', category_id = 1, category_source = 'manual', notes = 'keep', member_id = 1 WHERE id = ?").run(row.id);
    expect(saveOneZeroReport(db, report).inserted).toBe(0);
    expect(saveOneZeroReport(db, { ...report, start: '2026-04-12', transactions: report.transactions.slice(1) }).inserted).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM transactions').pluck().get()).toBe(3);
    expect(db.prepare('SELECT kind, category_source, notes, member_id FROM transactions WHERE id = ?').get(row.id))
      .toEqual({ kind: 'transfer', category_source: 'manual', notes: 'keep', member_id: 1 });
    expect(db.prepare('SELECT timestamp FROM balances').pluck().all()).toEqual(['2026-04-30 23:59:59']);
    expect(db.prepare('SELECT last_scraped_at FROM accounts').pluck().get()).toBeNull();
  });
  it('rolls back transactions when the existing report-date balance conflicts', () => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO balances (account_id, balance, timestamp) VALUES ('oneZero:123456789', 99, '2026-04-30 23:59:59')").run();
    expect(() => saveOneZeroReport(db!, parseOneZeroPages(fixture()))).toThrow('different balance');
    expect(db.prepare('SELECT COUNT(*) FROM transactions').pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM accounts WHERE company = 'oneZero'").pluck().get()).toBe(0);
  });
  it('previews without writing, imports through the endpoint, and rejects cross-origin writes', async () => {
    db = openDb(':memory:'); const app = Fastify(); transactionImportRoutes(app, db); insuranceRoutes(app, db);
    const request = { method: 'POST' as const, headers: { 'content-type': 'application/pdf' }, payload: Buffer.from('%PDF-test') };
    const preview = await app.inject({ ...request, url: '/api/imports/one-zero?preview=1' });
    expect(preview.statusCode).toBe(200); expect(preview.json().rows).toBe(3);
    expect(db.prepare('SELECT COUNT(*) FROM transactions').pluck().get()).toBe(0);
    const blocked = await app.inject({ ...request, url: '/api/imports/one-zero', headers: { ...request.headers, origin: 'https://example.com' } });
    expect(blocked.statusCode).toBe(403);
    const saved = await app.inject({ ...request, url: '/api/imports/one-zero' });
    expect(saved.statusCode).toBe(200); expect(saved.json().inserted).toBe(3);
    expect((await app.inject({ ...request, url: '/api/imports/one-zero' })).json().inserted).toBe(0);
    expect((await app.inject({ ...request, url: '/api/imports/one-zero', payload: Buffer.from('not a pdf') })).statusCode).toBe(400);
    await app.close();
  });
});
