import type { ExpenseDTO } from '@rd/contracts';
import { describe, expect, it } from 'vitest';
import { claimMeta, claimStatus, claimsFrom, payrollPeriodLabel, receiptProblem, totalText } from './expenses';

const claim = (over: Partial<ExpenseDTO> = {}): ExpenseDTO => ({
  id: 'e1', user_id: 'u1', user_name: 'Priya Nair', amount_cents: 4860, currency: 'GBP', spent_on: '2026-10-27', category: 'meals',
  project_id: 'p1', project_name: 'Website rebuild', client_name: 'Client A', billable: true, note: 'Lunch', has_receipt: true,
  status: 'pending', review_note: null, reviewed_by_name: null, reviewed_at: null, created_at: '2026-10-27T12:00:00Z',
  reimbursed_period: null, invoice: null, ...over,
});

describe('your claims', () => {
  it('reads each status the way the design does', () => {
    expect(claimStatus(claim())).toEqual({ label: 'Waiting', tone: 'outline', note: null });
    expect(claimStatus(claim({ status: 'rejected', reviewed_by_name: 'Sam Ortiz', review_note: 'please attach the receipt' }))).toMatchObject({
      label: 'Sent back', tone: 'warn', note: 'Sam: please attach the receipt',
    });
    expect(claimStatus(claim({ status: 'approved' })).note).toBe('Paid with the next payroll');
    const paid = claimStatus(claim({ status: 'approved', reimbursed_period: { from: '2026-09-01', to: '2026-09-30' }, invoice: { id: 'i', number: 'INV-2026-0014', status: 'issued' } }));
    expect(paid).toEqual({ label: 'Paid', tone: 'solid', note: 'September payroll · on invoice INV-2026-0014' });
  });

  it('names payroll periods and claim details', () => {
    expect(payrollPeriodLabel({ from: '2026-10-01', to: '2026-10-31' })).toBe('October payroll');
    expect(payrollPeriodLabel({ from: '2026-10-01', to: '2026-10-15' })).toBe('payroll 1 Oct – 15 Oct');
    expect(claimMeta(claim())).toBe('Meals · Client A · billable');
    expect(claimMeta(claim({ billable: false, project_name: null, category: 'equipment' }))).toBe('Equipment · Internal');
  });

  it('sums by currency and picks the range start', () => {
    expect(totalText([], 'GBP')).toBe('£0.00');
    expect(totalText([{ currency: 'GBP', cents: 4860, count: 1 }, { currency: 'USD', cents: 1200, count: 1 }], 'GBP')).toBe('£48.60 + US$12.00');
    expect(claimsFrom('quarter', '2026-10-29')).toBe('2026-08-01');
    expect(claimsFrom('quarter', '2026-02-03')).toBe('2025-12-01');
    expect(claimsFrom('year', '2026-10-29')).toBe('2026-01-01');
  });

  it('checks receipts before uploading', () => {
    expect(receiptProblem({ type: 'application/pdf', size: 1000 })).toBeNull();
    expect(receiptProblem({ type: 'text/plain', size: 10 })).toMatch(/photo/);
    expect(receiptProblem({ type: 'image/png', size: 11 * 1024 * 1024 })).toMatch(/10 MB/);
  });
});
