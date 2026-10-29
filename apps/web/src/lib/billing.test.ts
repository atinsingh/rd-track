import { describe, expect, it } from 'vitest';
import { annualSavingPercent, invoiceCents, seatPriceText } from './billing';

describe('billing terms', () => {
  it('prices Standard and Pro by term', () => {
    expect(seatPriceText(250, 'year')).toBe('US$2.50 per user / month, billed annually');
    expect(seatPriceText(500, 'month')).toBe('US$5 per user / month');
    expect(seatPriceText(0, 'month')).toBe('US$0');
  });
  it('invoices an annual term 12 months at a time', () => {
    expect(invoiceCents('standard', 'year', 4)).toBe(12_000);
    expect(invoiceCents('standard', 'month', 4)).toBe(2_000);
    expect(invoiceCents('pro', 'year', 10)).toBe(60_000);
    expect(invoiceCents('pro', 'month', 10)).toBe(10_000);
    expect(invoiceCents('free', 'year', 2)).toBe(0);
  });
  it('an annual term saves half', () => {
    expect(annualSavingPercent('standard')).toBe(50);
    expect(annualSavingPercent('pro')).toBe(50);
    expect(annualSavingPercent('free')).toBe(0);
  });
});
