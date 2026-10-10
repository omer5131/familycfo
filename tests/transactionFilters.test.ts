import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { openDb } from '../src/db/connection.js';
import { transactionRoutes } from '../src/server/routes/transactions.js';

describe('transaction category exclusions', () => {
  it('excludes parent and child categories before totals and pagination, and preserves uncategorized rows', async () => {
    const db = openDb(':memory:');
    const app = Fastify();
    transactionRoutes(app, db);
    try {
      const parent = Number(db.prepare("INSERT INTO categories(name) VALUES ('Filter parent')").run().lastInsertRowid);
      const child = Number(db.prepare("INSERT INTO categories(name, parent_id) VALUES ('Filter child', ?)").run(parent).lastInsertRowid);
      const other = Number(db.prepare("INSERT INTO categories(name) VALUES ('Filter other')").run().lastInsertRowid);
      db.prepare("INSERT INTO accounts(id, company, kind) VALUES ('test:bank', 'test', 'bank')").run();
      const insert = db.prepare(`INSERT INTO transactions(identifier, account_id, date, description, original_amount, charged_amount, category_id, kind)
        VALUES (?, 'test:bank', '2026-10-01', 'movement', ?, ?, ?, ?)`);
      const ids = [
        insert.run('a', -100, -100, parent, 'expense'),
        insert.run('b', 100, 100, child, 'income'),
        insert.run('c', -20, -20, other, 'expense'),
        insert.run('d', -5, -5, null, 'expense'),
      ].map(r => Number(r.lastInsertRowid));
      const result = (await app.inject({ url: `/api/transactions?excludeCategories=${parent},${other}&limit=1` })).json();
      expect(result.total).toBe(1);
      expect(result.rows[0].id).toBe(ids[3]);
      expect(result.totals).toMatchObject({ income: 0, spend: 5 });
      const childOnly = (await app.inject({ url: `/api/transactions?excludeCategories=${child}&limit=1` })).json();
      expect(childOnly.total).toBe(3);
      expect(childOnly.rows).toHaveLength(1);
      expect(childOnly.totals).toMatchObject({ income: 0, spend: 125 });
      const conflict = (await app.inject({ url: `/api/transactions?category=${parent}&excludeCategories=${parent}` })).json();
      expect(conflict.total).toBe(0);
      await app.inject({ method: 'POST', url: '/api/transactions/bulk', payload: { ids: ids.slice(0, 2), patch: { kind: 'transfer' } } });
      const transfers = (await app.inject({ url: `/api/transactions?category=${parent}` })).json();
      expect(transfers.rows).toHaveLength(2);
      expect(transfers.rows.every((r: { kind: string }) => r.kind === 'transfer')).toBe(true);
      expect(transfers.totals).toMatchObject({ income: 0, spend: 0, moved: 200 });
      expect(db.prepare('SELECT DISTINCT kind_source FROM transactions WHERE id IN (?, ?)').pluck().all(ids[0], ids[1])).toEqual(['manual']);
    } finally {
      await app.close();
      db.close();
    }
  });
});
