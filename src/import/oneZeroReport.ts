import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { getDb, type DB } from '../db/connection.js';
import { saveTransactions } from '../db/ingestRepo.js';
import { normalizeTransactions, type ScrapedTransaction } from '../ingest/normalize.js';
import { runPipeline } from '../pipeline.js';

export interface ReportText { str: string; x: number; y: number; w: number }
export interface OneZeroReport {
  accountNumber: string; start: string; end: string;
  openingBalance: number; closingBalance: number; debits: number; credits: number;
  transactions: ScrapedTransaction[];
}
const clean = (s: string) => s.replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim();
function date(s: string): string {
  const match = clean(s).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) throw new Error('Invalid report date');
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  if (new Date(iso).toISOString().slice(0, 10) !== iso) throw new Error('Invalid report date');
  return iso;
}
function money(s: string): number {
  const matches = clean(s).match(/-?\d[\d,]*(?:\.\d{1,2})?/g);
  if (matches?.length !== 1) throw new Error('Invalid report amount');
  const value = Number(matches[0].replaceAll(',', ''));
  if (!Number.isFinite(value)) throw new Error('Invalid report amount');
  return value;
}
const cents = (n: number) => Math.round(n * 100);

/** Supports the text-based ONE ZERO ILS statement with six table columns. */
export function parseOneZeroPages(pages: ReportText[][]): OneZeroReport {
  const first = pages[0]?.filter(t => clean(t.str));
  if (!first?.some(t => t.str.includes('ONE ZERO')) || !first.some(t => t.str.includes('תנועות שקליות'))) {
    throw new Error('Select a text-based ONE ZERO ILS transaction report');
  }
  const accountLine = first.find(t => t.y > 760 && t.x > 380 && t.x < 470 && /\d{5,}/.test(t.str));
  const accountNumber = accountLine?.str.match(/\d{5,}/)?.[0];
  const range = first.map(t => t.str).join(' ').match(/(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})/);
  if (!accountNumber || !range) throw new Error('The report account or date range is missing');
  const summary = (label: string) => {
    const field = first.find(t => t.str.includes(label));
    const value = field && first.find(t => t.x > 300 && t.x < 450 && Math.abs(t.y - field.y) < 3 && /\d/.test(t.str));
    if (!value) throw new Error(`Missing report total: ${label}`);
    return money(value.str);
  };
  const report: OneZeroReport = {
    accountNumber, start: date(range[1]), end: date(range[2]),
    openingBalance: summary('יתרה קודמת'), closingBalance: summary('יתרה חדשה'),
    debits: summary('סך כל החיובים'), credits: summary('סך כל הזיכויים'), transactions: [],
  };
  let running = cents(report.openingBalance), debitTotal = 0, creditTotal = 0;
  for (const page of pages) {
    const items = page.filter(t => clean(t.str));
    const anchors = items.filter(t => t.x > 470 && /^\d{2}\/\d{2}\/\d{4}$/.test(clean(t.str))).sort((a, b) => b.y - a.y);
    if (!anchors.length) throw new Error('A report page has no transaction rows');
    for (let i = 0; i < anchors.length; i++) {
      const anchor = anchors[i];
      const cell = (left: number, right: number) => {
        const values = items.filter(t => t.x >= left && t.x < right && Math.abs(t.y - anchor.y) < 2);
        if (values.length !== 1) throw new Error('A report row has a missing or ambiguous cell');
        return values[0].str;
      };
      const debit = money(cell(220, 300)), credit = money(cell(140, 220));
      const balance = money(cell(40, 130));
      if (debit < 0 || credit < 0 || (debit > 0) === (credit > 0)) throw new Error('A report row must have one debit or credit');
      const upper = i === 0 ? anchor.y + 17 : (anchors[i - 1].y + anchor.y) / 2;
      const lower = i === anchors.length - 1 ? anchor.y - 17 : (anchors[i + 1].y + anchor.y) / 2;
      const description = items.filter(t => t.x >= 300 && t.x < 390 && t.y < upper && t.y > lower)
        .sort((a, b) => b.y - a.y || b.x - a.x).map(t => clean(t.str)).join(' ');
      const txnDate = date(anchor.str), valueDate = date(cell(395, 460));
      if (!description || txnDate < report.start || txnDate > report.end) throw new Error('Invalid report row description or date');
      debitTotal += cents(debit); creditTotal += cents(credit); running += cents(credit) - cents(debit);
      if (running !== cents(balance)) throw new Error('Report running balance does not match the transaction amounts');
      report.transactions.push({
        date: txnDate, processedDate: valueDate, description,
        originalAmount: credit - debit, chargedAmount: credit - debit,
        originalCurrency: 'ILS', chargedCurrency: 'ILS', type: 'normal' as ScrapedTransaction['type'],
        status: 'completed' as ScrapedTransaction['status'],
        // A running balance distinguishes identical same-day payments across overlapping reports.
        identifier: `one-zero-pdf:${txnDate}:${valueDate}:${cents(balance)}:${cents(credit - debit)}`,
        rawTransaction: { source: 'one-zero-pdf', balance, debit, credit, valueDate },
      });
    }
  }
  if (debitTotal !== cents(report.debits) || creditTotal !== cents(report.credits) || running !== cents(report.closingBalance)) {
    throw new Error('Report totals do not match the extracted transactions; nothing was imported');
  }
  return report;
}

export async function readOneZeroPdf(data: Uint8Array): Promise<OneZeroReport> {
  const task = getDocument({ data: new Uint8Array(data), useSystemFonts: true, isEvalSupported: false });
  const document = await task.promise;
  try {
    if (document.numPages > 100) throw new Error('Reports must have at most 100 pages');
    const pages: ReportText[][] = [];
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n);
      if (Math.abs(page.getViewport({ scale: 1 }).width - 595) > 3) throw new Error('Unsupported report page layout');
      const content = await page.getTextContent();
      pages.push(content.items.flatMap(t => 'str' in t ? [{ str: t.str, x: t.transform[4], y: t.transform[5], w: t.width }] : []));
    }
    return parseOneZeroPages(pages);
  } finally { await task.destroy(); }
}

export function saveOneZeroReport(db: DB, report: OneZeroReport) {
  const accountId = `oneZero:${report.accountNumber}`;
  return db.transaction(() => {
    db.prepare(`INSERT INTO accounts (id, company, kind, display_name, currency)
      VALUES (?, 'oneZero', 'bank', ?, 'ILS') ON CONFLICT(id) DO NOTHING`).run(accountId, `ONE ZERO ${report.accountNumber}`);
    const result = saveTransactions(db, normalizeTransactions(accountId, report.transactions));
    // Use the report end date, not today's date. Do not make an old balance look current.
    const timestamp = `${report.end} 23:59:59`;
    const existing = db.prepare('SELECT balance FROM balances WHERE account_id = ? AND timestamp = ?').get(accountId, timestamp) as { balance: number } | undefined;
    if (existing && cents(existing.balance) !== cents(report.closingBalance)) throw new Error('A different balance already exists for this report date');
    if (!existing) db.prepare('INSERT INTO balances (account_id, balance, timestamp) VALUES (?, ?, ?)').run(accountId, report.closingBalance, timestamp);
    return { accountId, start: report.start, end: report.end, rows: report.transactions.length,
      inserted: result.insertedIds.length, updated: result.updated, closingBalance: report.closingBalance };
  })();
}

export async function importOneZeroPdf(db: DB, data: Uint8Array) {
  const report = await readOneZeroPdf(data);
  const result = saveOneZeroReport(db, report);
  try { await runPipeline(db, { fetchRates: false }); }
  catch { return { ...result, warning: 'Transactions were saved. Run the pipeline again to update analytics.' }; }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: npm run import:one-zero -- <report.pdf> [--preview]');
  const data = new Uint8Array(readFileSync(file));
  if (process.argv.includes('--preview')) {
    const { transactions, ...summary } = await readOneZeroPdf(data);
    console.log({ ...summary, rows: transactions.length });
  } else console.log(await importOneZeroPdf(getDb(), data));
}
