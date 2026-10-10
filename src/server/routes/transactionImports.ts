import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/connection.js';
import { readOneZeroPdf, saveOneZeroReport } from '../../import/oneZeroReport.js';
import { runPipeline } from '../../pipeline.js';
import { scrapeRunning } from '../scrapeJob.js';

export function transactionImportRoutes(app: FastifyInstance, db: DB) {
  app.register(async scoped => registerRoutes(scoped, db));
}

function registerRoutes(app: FastifyInstance, db: DB) {
  // Keep upload parsing local to this route. Insurance also registers a PDF parser.
  if (app.hasContentTypeParser('application/pdf')) app.removeContentTypeParser('application/pdf');
  app.addContentTypeParser('application/pdf', { parseAs: 'buffer', bodyLimit: 12 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.post<{ Querystring: { preview?: string } }>('/api/imports/one-zero', { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const origins = [`http://127.0.0.1:${process.env.WEB_PORT ?? '5180'}`, `http://localhost:${process.env.WEB_PORT ?? '5180'}`];
    if (req.headers.origin && !origins.includes(req.headers.origin)) return reply.code(403).send({ error: 'Cross-origin requests are not allowed' });
    if (scrapeRunning()) return reply.code(409).send({ error: 'Wait for the current sync to finish' });
    if (!Buffer.isBuffer(req.body) || req.body.subarray(0, 5).toString() !== '%PDF-') return reply.code(400).send({ error: 'Select a PDF report' });
    let report;
    try { report = await readOneZeroPdf(req.body); }
    catch (err) { return reply.code(400).send({ error: (err as Error).message }); }
    if (req.query.preview === '1') {
      const { transactions, ...summary } = report;
      return { ...summary, rows: transactions.length };
    }
    let result;
    try { result = saveOneZeroReport(db, report); }
    catch (err) { return reply.code(409).send({ error: (err as Error).message }); }
    try { await runPipeline(db, { fetchRates: false }); }
    catch { return { ...result, warning: 'התנועות נשמרו. יש ללחוץ על חישוב מחדש לעדכון הדוחות.' }; }
    return result;
  });
}
