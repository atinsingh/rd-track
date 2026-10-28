import { z } from 'zod';
import { uuid } from './events';

/**
 * Stage 3 insights (gap analysis §Stage 3 item 4): wellbeing and workload signals,
 * shown to the employee first. Team views are aggregates over at least
 * MIN_INSIGHTS_GROUP_SIZE people (RPT-07) so no individual can be singled out.
 */

export const MIN_INSIGHTS_GROUP_SIZE = 5;
/** A focus block: ≥ 30 continuous minutes in one session with input in most minutes. */
export const FOCUS_MIN_MINUTES = 30;
/** Days with more tracked time than this count as long days. */
export const LONG_DAY_SECONDS = 10 * 3600;
/** Stretches without a ≥ 10 minute break longer than this are flagged as breakless. */
export const BREAKLESS_STRETCH_SECONDS = 4 * 3600;
export const DEFAULT_WORKING_HOURS = { start: '08:00', end: '18:00' } as const;

export const APP_CATEGORIES = ['core_work', 'supporting', 'communication', 'break'] as const;
export type AppCategory = (typeof APP_CATEGORIES)[number];
export const APP_CATEGORY_LABELS: Record<AppCategory | 'uncategorized', string> = {
  core_work: 'Core work apps',
  supporting: 'Supporting apps',
  communication: 'Communication',
  break: 'Breaks and personal',
  uncategorized: 'Not categorized',
};

export interface DayInsight {
  date: string;
  tracked_seconds: number;
  focus_seconds: number;
  focus_blocks: number;
  after_hours_seconds: number;
  weekend: boolean;
  longest_stretch_seconds: number;
  long_day: boolean;
}

export interface PersonalInsights {
  from: string;
  to: string;
  tz: string;
  working_hours: { start: string; end: string };
  tracked_seconds: number;
  focus: { seconds: number; blocks: number; longest_block_seconds: number; share_percent: number | null };
  after_hours_seconds: number;
  weekend_seconds: number;
  long_days: number;
  breakless_days: number;
  longest_stretch_seconds: number;
  work_apps: { category: AppCategory | 'uncategorized'; seconds: number }[];
  days: DayInsight[];
}

export interface TeamInsights {
  team: { id: string; name: string };
  from: string;
  to: string;
  member_count: number;
  min_group_size: number;
  per_person: {
    tracked_seconds: number;
    focus_seconds: number;
    after_hours_seconds: number;
    weekend_seconds: number;
  };
  /** How many people had at least one long day / after-hours work — counts, never names. */
  people_with_long_days: number;
  people_with_after_hours: number;
  focus_share_percent: number | null;
}

export const appCategoryRequest = z.strictObject({
  team_id: uuid.nullable().optional(),
  app_identifier: z.string().trim().min(1).max(255),
  category: z.enum(APP_CATEGORIES),
});
export interface AppCategoryDTO {
  id: string;
  team_id: string | null;
  team_name: string | null;
  app_identifier: string;
  category: AppCategory;
  created_at: string;
}

// ───────────── outbound webhooks (INT-03) ─────────────

export const WEBHOOK_EVENTS = ['session.started', 'session.stopped', 'time_correction.approved', 'export.ready'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export const webhookCreateRequest = z.strictObject({
  url: z
    .url()
    .max(2000)
    .refine((u) => u.startsWith('https://'), 'Webhook URLs must use https'),
  description: z.string().max(200).optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
});
export interface WebhookEndpointDTO {
  id: string;
  url: string;
  description: string | null;
  events: WebhookEventType[];
  active: boolean;
  created_at: string;
  /** Returned once, at creation. */
  signing_secret?: string;
}
export interface WebhookDeliveryDTO {
  id: string;
  event_type: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

/**
 * Body of every webhook POST. Data carries ids and times only — never screenshots,
 * activity detail, app names or anything typed.
 */
export interface WebhookPayload {
  id: string;
  type: WebhookEventType | 'webhook.test';
  created_at: string;
  organization_id: string;
  data: Record<string, string | number | boolean | null>;
}
