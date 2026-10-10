/** Do not infer a password failure from an HTML response. */
export function scrapeErrorMessage(company: string, message: string | undefined): string | undefined {
  if (company === 'oneZero' && message?.includes("Unexpected token '<'")) {
    return 'ONE ZERO החזיר דף HTML במקום נתוני חיבור. ייתכן שהבנק חסם את החיבור האוטומטי. לא ניתן להשלים את הסנכרון כרגע. שגיאה זו אינה מעידה שהסיסמה שגויה.';
  }
  return message;
}
