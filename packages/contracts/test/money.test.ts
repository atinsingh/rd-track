import { describe, expect, it } from 'vitest';
import {
  billableHours,
  budgetStatus,
  invoiceLinesRequest,
  invoiceTotals,
  lineAmountCents,
  payRateCreateRequest,
  projectBudgetRequest,
  taxCents,
} from '../src';

describe('money rounding rule', () => {
  it('rounds seconds to the minute, then hours to two decimals', () => {
    expect(billableHours(29)).toBe(0); // 0 min
    expect(billableHours(30)).toBe(0.02); // 1 min = 0.0167 h → 0.02
    expect(billableHours(3600)).toBe(1);
    expect(billableHours(5400 + 29)).toBe(1.5); // 90 min
    expect(billableHours(20 * 60)).toBe(0.33);
    expect(billableHours(40 * 60)).toBe(0.67);
  });
  it('computes line amounts, tax and totals in cents, half up', () => {
    expect(lineAmountCents(0.33, 15_000)).toBe(4950);
    expect(lineAmountCents(1.01, 3333)).toBe(3366); // 3366.33
    expect(lineAmountCents(0.5, 1)).toBe(1); // 0.5 cent rounds up
    expect(taxCents(10_005, 1300)).toBe(1301); // 1300.65
    expect(taxCents(1, 5000)).toBe(1); // 0.5 cent rounds up
    expect(invoiceTotals([4950, 3366], 825)).toEqual({ subtotal_cents: 8316, tax_cents: 686, total_cents: 9002 });
  });
  it('derives budget status from thresholds', () => {
    expect(budgetStatus(10, [80, 100])).toBe('ok');
    expect(budgetStatus(80, [80, 100])).toBe('near');
    expect(budgetStatus(60, [50, 100])).toBe('near');
    expect(budgetStatus(100, [80])).toBe('reached');
    expect(budgetStatus(85, [])).toBe('near');
  });
});

describe('money request schemas', () => {
  it('validates rates, budgets and lines strictly', () => {
    const user_id = '6f1d9a4e-1d2b-4c3a-9f7e-2a1b3c4d5e6f';
    expect(payRateCreateRequest.parse({ user_id, amount_cents: 4500, effective_from: '2026-10-01' }).currency).toBe('USD');
    expect(payRateCreateRequest.safeParse({ user_id, amount_cents: 45.5, effective_from: '2026-10-01' }).success).toBe(false);
    expect(payRateCreateRequest.safeParse({ user_id, amount_cents: 1, currency: 'usd', effective_from: '2026-10-01' }).success).toBe(false);
    expect(payRateCreateRequest.safeParse({ user_id, amount_cents: 1, effective_from: '2026-10-01', extra: 1 }).success).toBe(false);
    expect(projectBudgetRequest.safeParse({ kind: 'hours', limit_hours: 40.5 }).success).toBe(true);
    expect(projectBudgetRequest.safeParse({ kind: 'amount', limit_cents: 100 }).success).toBe(false); // needs currency
    expect(projectBudgetRequest.safeParse({ kind: 'hours', limit_hours: 1.005 }).success).toBe(false);
    expect(invoiceLinesRequest.safeParse({ lines: [{ description: 'Design', hours: 1.1, rate_cents: 100 }] }).success).toBe(true);
    expect(invoiceLinesRequest.safeParse({ lines: [{ description: 'Design', hours: -1, rate_cents: 100 }] }).success).toBe(false);
  });
});
