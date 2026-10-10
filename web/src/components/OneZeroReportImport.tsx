import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

interface Preview { accountNumber: string; start: string; end: string; rows: number; closingBalance: number }
interface Result { inserted: number; updated: number; warning?: string }

export function OneZeroReportImport() {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  async function upload<T>(previewOnly: boolean): Promise<T> {
    if (!file) throw new Error('יש לבחור קובץ PDF');
    const response = await fetch(`/api/imports/one-zero${previewOnly ? '?preview=1' : ''}`, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'ייבוא הדוח נכשל');
    return data;
  }
  const check = useMutation({ mutationFn: () => upload<Preview>(true), onSuccess: setPreview });
  const save = useMutation({ mutationFn: () => upload<Result>(false), onSuccess: data => {
    setResult(data); setPreview(null); qc.invalidateQueries();
  } });
  const busy = check.isPending || save.isPending;
  return <div className="mb-6 max-w-xl space-y-3 rounded-xl border p-4">
    <h3 className="font-semibold">ייבוא תנועות ONE ZERO מדוח PDF</h3>
    <p className="text-sm text-zinc-500">אפשר לייבא דוח ״פירוט תנועות שקליות בחשבון״ גם ללא חיבור לבנק. הקובץ מעובד במחשב זה. ייבוא חוזר של אותו דוח אינו מוסיף תנועות כפולות.</p>
    <label className="block">דוח תנועות בשקלים
      <input className="input mt-1" type="file" accept="application/pdf,.pdf" disabled={busy} onChange={e => {
        setFile(e.target.files?.[0] ?? null); setPreview(null); setResult(null); check.reset(); save.reset();
      }} />
    </label>
    <button className="btn" disabled={!file || busy} onClick={() => check.mutate()}>{check.isPending ? 'בודק…' : 'בדוק דוח'}</button>
    {preview && <div role="status" className="space-y-2 text-sm">
      <p>חשבון {preview.accountNumber} · {preview.start} – {preview.end} · {preview.rows} תנועות</p>
      <p>יתרה בסוף תקופת הדוח: ₪{preview.closingBalance.toLocaleString('he-IL')}</p>
      <button className="btn btn-primary" disabled={busy} onClick={() => save.mutate()}>{save.isPending ? 'מייבא…' : 'ייבא תנועות'}</button>
    </div>}
    {result && <p role="status">נוספו {result.inserted} תנועות. {result.updated} תנועות כבר היו במערכת.{result.warning && ` ${result.warning}`}</p>}
    {(check.error || save.error) && <p role="alert">{(check.error || save.error)?.message}</p>}
  </div>;
}
