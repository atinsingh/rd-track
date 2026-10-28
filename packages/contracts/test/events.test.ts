import { describe, expect, it } from 'vitest';
import { eventEnvelopeSchema, partialPolicySettingsSchema } from '../src';

const base = {
  event_id: '6f1d9a4e-1d2b-4c3a-9f7e-2a1b3c4d5e6f',
  organization_id: '0b6c7f1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f',
  device_id: '1c2d3e4f-5a6b-4c7d-8e9f-1a2b3c4d5e6f',
  session_id: '2d3e4f5a-6b7c-4d8e-9f0a-2b3c4d5e6f7a',
  policy_version: 3,
  occurred_at: '2026-10-28T09:41:00Z',
  sequence: 12,
};

describe('event envelope', () => {
  it('accepts a valid activity bucket', () => {
    const r = eventEnvelopeSchema.safeParse({
      ...base,
      event_type: 'activity_bucket.v1',
      payload: {
        bucket_start: '2026-10-28T09:41:00Z',
        active_seconds: 40,
        idle_seconds: 20,
        keyboard_count: 120,
        mouse_count: 33,
        data_quality: 'ok',
      },
    });
    expect(r.success).toBe(true);
  });

  it('rejects content smuggled into a payload', () => {
    const r = eventEnvelopeSchema.safeParse({
      ...base,
      event_type: 'activity_bucket.v1',
      payload: {
        bucket_start: '2026-10-28T09:41:00Z',
        active_seconds: 40,
        idle_seconds: 20,
        keyboard_count: 120,
        mouse_count: 33,
        data_quality: 'ok',
        typed_text: 'hunter2',
      },
    });
    expect(r.success).toBe(false);
  });

  it('rejects a window title on app usage', () => {
    const r = eventEnvelopeSchema.safeParse({
      ...base,
      event_type: 'app_usage.v1',
      payload: {
        app_identifier: 'com.microsoft.VSCode',
        app_name: 'Code',
        window_title: 'secret-plan.md',
        started_at: '2026-10-28T09:41:00Z',
        duration_seconds: 60,
      },
    });
    expect(r.success).toBe(false);
  });

  it('rejects a URL path where only a domain is allowed', () => {
    const r = eventEnvelopeSchema.safeParse({
      ...base,
      event_type: 'app_usage.v1',
      payload: {
        app_identifier: 'com.google.Chrome',
        app_name: 'Chrome',
        domain: 'example.com/private?q=1',
        started_at: '2026-10-28T09:41:00Z',
        duration_seconds: 60,
      },
    });
    expect(r.success).toBe(false);
  });

  it('rejects buckets that are not minute-aligned or exceed 60 seconds', () => {
    const payload = {
      bucket_start: '2026-10-28T09:41:30Z',
      active_seconds: 10,
      idle_seconds: 10,
      keyboard_count: 1,
      mouse_count: 1,
      data_quality: 'ok',
    };
    expect(eventEnvelopeSchema.safeParse({ ...base, event_type: 'activity_bucket.v1', payload }).success).toBe(false);
    expect(
      eventEnvelopeSchema.safeParse({
        ...base,
        event_type: 'activity_bucket.v1',
        payload: { ...payload, bucket_start: '2026-10-28T09:41:00Z', active_seconds: 50, idle_seconds: 20 },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown event types', () => {
    expect(eventEnvelopeSchema.safeParse({ ...base, event_type: 'keystrokes.v1', payload: {} }).success).toBe(false);
  });
});

describe('partial policy settings', () => {
  it('rejects unknown settings keys', () => {
    expect(partialPolicySettingsSchema.safeParse({ screenshots: { record_video: true } }).success).toBe(false);
  });
  it('enforces bounds', () => {
    expect(partialPolicySettingsSchema.safeParse({ screenshots: { interval_minutes: 1 } }).success).toBe(false);
    expect(partialPolicySettingsSchema.safeParse({ screenshots: { interval_minutes: 15 } }).success).toBe(true);
  });
});
