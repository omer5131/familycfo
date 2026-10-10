import { expect, it } from 'vitest';
import { scrapeErrorMessage } from '../src/ingest/scrapeError.js';

it('explains ONE ZERO HTML responses without labelling credentials invalid', () => {
  expect(scrapeErrorMessage('oneZero', `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`)).toContain('דף HTML');
  expect(scrapeErrorMessage('oneZero', 'Invalid password')).toBe('Invalid password');
  expect(scrapeErrorMessage('leumi', "Unexpected token '<'")).toBe("Unexpected token '<'");
  expect(scrapeErrorMessage('oneZero', undefined)).toBeUndefined();
});
