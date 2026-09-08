import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { usageResponseSchema } from '../claude-ai/usage.js';
import { messageLimitEventSchema } from '../claude-ai/message-limit.js';
import { rateLimitEventSchema } from '../claude-ai/code-rate-limit.js';
import {
  normalizeUsageResponse,
  upgradeSnapshotFromMessageLimit,
  upgradeSnapshotFromCodeRateLimitEvent,
  type LimitSnapshot,
} from './limit-snapshot.js';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/claude-ai',
);

function loadUsage(name: string) {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf-8'));
  const { _fixture_meta, ...body } = raw;
  return usageResponseSchema.parse(body);
}

function loadMessageLimit(name: string) {
  const text = readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
  const dataLine = text.split('\n').find((line) => line.startsWith('data:') && line.includes('message_limit'));
  if (!dataLine) throw new Error(`no message_limit data line in ${name}`);
  const raw = JSON.parse(dataLine.slice('data:'.length).trim());
  return messageLimitEventSchema.parse(raw).message_limit;
}

function loadRateLimitInfo(name: string) {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf-8'));
  const { _fixture_meta, ...body } = raw;
  return rateLimitEventSchema.parse(body).payload.rate_limit_info;
}

describe('normalizeUsageResponse', () => {
  it('extracts session and weekly bars from the overage fixture', () => {
    const usage = loadUsage('usage.get.overage.json');
    const snapshot = normalizeUsageResponse(usage, '2026-08-26T17:20:00Z');

    expect(snapshot.session).toEqual({
      percent: 39,
      resetsAt: '2026-08-26T19:00:00.121042+00:00',
      severity: 'normal',
      isActive: true,
    });
    expect(snapshot.weekly).toEqual({
      percent: 31,
      resetsAt: '2026-08-29T13:00:00.121059+00:00',
      severity: 'normal',
      isActive: false,
    });
  });

  it('extracts bars from the credits-disabled fixture, where weekly is the active one', () => {
    const usage = loadUsage('usage.get.credits-disabled.json');
    const snapshot = normalizeUsageResponse(usage, '2026-08-29T09:28:00Z');

    expect(snapshot.session?.percent).toBe(29);
    expect(snapshot.session?.isActive).toBe(false);
    expect(snapshot.weekly?.percent).toBe(56);
    expect(snapshot.weekly?.isActive).toBe(true);
  });

  it('leaves a bar null if its kind is absent from limits[]', () => {
    const usage = loadUsage('usage.get.overage.json');
    const snapshot = normalizeUsageResponse({ ...usage, limits: [] }, '2026-08-26T17:20:00Z');

    expect(snapshot.session).toBeNull();
    expect(snapshot.weekly).toBeNull();
  });

  it('extracts extra credits from the overage fixture, converting minor units via decimal_places', () => {
    const usage = loadUsage('usage.get.overage.json');
    const snapshot = normalizeUsageResponse(usage, '2026-08-26T17:20:00Z');

    // Real fixture values: used_credits: 4628, monthly_limit: 6155, decimal_places: 2.
    expect(snapshot.extraCredits).toEqual({
      percent: 75.19090170593013,
      usedAmount: 46.28,
      limitAmount: 61.55,
      currency: 'USD',
    });
  });

  it('is null when extra credits are disabled', () => {
    const usage = loadUsage('usage.get.credits-disabled.json');
    const snapshot = normalizeUsageResponse(usage, '2026-08-29T09:28:00Z');
    expect(snapshot.extraCredits).toBeNull();
  });
});

describe('upgradeSnapshotFromMessageLimit', () => {
  it('returns null for the overage branch — no session/weekly windows to apply', () => {
    const detail = loadMessageLimit('message_limit.overage.sse.txt');
    expect(upgradeSnapshotFromMessageLimit(detail, null, '2026-08-29T09:00:00Z')).toBeNull();
  });

  it('upgrades the representative window with exact percent + confirmed severity/isActive', () => {
    const detail = loadMessageLimit('message_limit.five_hour.sse.txt');
    const snapshot = upgradeSnapshotFromMessageLimit(detail, null, '2026-08-29T09:28:30Z');

    // representativeClaim is "five_hour" here, so session is the confirmed (resolved) window:
    // exact utilization (0.29 -> 29) and real severity/isActive from resolved.limit.
    expect(snapshot?.session).toEqual({
      percent: 29,
      resetsAt: '2026-08-29T12:40:00+00:00',
      severity: 'normal',
      isActive: true,
    });
  });

  it('still updates the non-representative window\'s percent/resetsAt from real data, but carries severity/isActive forward', () => {
    const detail = loadMessageLimit('message_limit.five_hour.sse.txt');
    const previous: LimitSnapshot = {
      capturedAt: '2026-08-29T09:00:00Z',
      source: 'usage',
      session: null,
      weekly: { percent: 50, resetsAt: '2026-08-29T00:00:00Z', severity: 'warning', isActive: true },
    };
    const snapshot = upgradeSnapshotFromMessageLimit(detail, previous, '2026-08-29T09:28:30Z');

    // "7d" window's exact utilization (0.55 -> 55) and its own resets_at (epoch seconds,
    // converted) are real, fresh data — but severity/isActive are carried over from `previous`
    // since no fixture has ever shown what a non-representative window resolves to.
    expect(snapshot?.weekly).toEqual({
      percent: 55,
      resetsAt: new Date(1788008400 * 1000).toISOString(),
      severity: 'warning',
      isActive: true,
    });
  });

  it('defaults severity/isActive for the non-representative window when there is no previous snapshot', () => {
    const detail = loadMessageLimit('message_limit.five_hour.sse.txt');
    const snapshot = upgradeSnapshotFromMessageLimit(detail, null, '2026-08-29T09:28:30Z');

    expect(snapshot?.weekly).toMatchObject({ severity: 'normal', isActive: false });
  });

  it('rounds a utilization*100 floating-point artifact to a clean percent', () => {
    // 0.29 * 100 === 28.999999999999996 in plain JS float math — not real precision, noise.
    expect(0.29 * 100).not.toBe(29);
    const detail = loadMessageLimit('message_limit.five_hour.sse.txt');
    const snapshot = upgradeSnapshotFromMessageLimit(detail, null, '2026-08-29T09:28:30Z');
    expect(snapshot?.session?.percent).toBe(29);
    expect(snapshot?.weekly?.percent).toBe(55);
  });

  it('marks the resulting snapshot as message_limit-sourced', () => {
    const detail = loadMessageLimit('message_limit.five_hour.sse.txt');
    const snapshot = upgradeSnapshotFromMessageLimit(detail, null, '2026-08-29T09:28:30Z');
    expect(snapshot?.source).toBe('message_limit');
  });

  it('carries extraCredits forward from the previous snapshot — message_limit events never carry it', () => {
    const detail = loadMessageLimit('message_limit.five_hour.sse.txt');
    const previous: LimitSnapshot = {
      capturedAt: '2026-08-29T09:00:00Z',
      source: 'usage',
      session: null,
      weekly: null,
      extraCredits: { percent: 75, usedAmount: 46.28, limitAmount: 61.55, currency: 'USD' },
    };
    const snapshot = upgradeSnapshotFromMessageLimit(detail, previous, '2026-08-29T09:28:30Z');
    expect(snapshot?.extraCredits).toEqual(previous.extraCredits);
  });

  it('defaults extraCredits to null with no previous snapshot', () => {
    const detail = loadMessageLimit('message_limit.five_hour.sse.txt');
    const snapshot = upgradeSnapshotFromMessageLimit(detail, null, '2026-08-29T09:28:30Z');
    expect(snapshot?.extraCredits).toBeNull();
  });

  describe('representativeClaim: "seven_day" — hand-built, NOT a captured fixture', () => {
    // A real "seven_day" representativeClaim event has never been captured (only "five_hour"
    // has). This object is hand-built to the schema — every field's shape is real and confirmed
    // elsewhere — but the specific combination of values here is inference, not observation.
    // This test only proves CLAIM_TO_BAR's "seven_day" -> weekly mapping behaves as designed.
    // Replace with a fixture-backed test if a real capture of this branch ever shows up.
    const syntheticSevenDayEvent = {
      type: 'message_limit',
      message_limit: {
        type: 'within_limit',
        resetsAt: null,
        remaining: null,
        perModelLimit: null,
        representativeClaim: 'seven_day',
        overageDisabledReason: 'org_level_disabled',
        overageInUse: false,
        windows: {
          '5h': { status: 'within_limit', resets_at: 1788007200, utilization: 0.29 },
          '7d': { status: 'within_limit', resets_at: 1788008400, utilization: 0.55 },
        },
        resolved: {
          status: 'ok',
          limit: {
            kind: 'weekly_all',
            group: 'weekly',
            percent: 55,
            severity: 'normal',
            resets_at: '2026-08-29T13:00:00+00:00',
            scope: null,
            is_active: true,
          },
          spend: null,
          disabled_reason: 'org_level_disabled',
          notice: null,
        },
      },
    };

    it('parses against the real schema (structurally valid, even though never observed)', () => {
      expect(() => messageLimitEventSchema.parse(syntheticSevenDayEvent)).not.toThrow();
    });

    it('resolves the weekly bar from resolved.limit, and carries session forward instead of guessing it', () => {
      const detail = messageLimitEventSchema.parse(syntheticSevenDayEvent).message_limit;
      const previous: LimitSnapshot = {
        capturedAt: '2026-08-29T09:00:00Z',
        source: 'usage',
        session: { percent: 39, resetsAt: '2026-08-29T12:00:00Z', severity: 'warning', isActive: true },
        weekly: null,
      };

      const snapshot = upgradeSnapshotFromMessageLimit(detail, previous, '2026-08-29T09:28:30Z');

      expect(snapshot?.weekly).toEqual({
        percent: 55,
        resetsAt: '2026-08-29T13:00:00+00:00',
        severity: 'normal',
        isActive: true,
      });
      // Session isn't the representative window here — percent/resetsAt still update from the
      // real "5h" fraction, but severity/isActive carry forward from `previous` (warning/true),
      // not from resolved.limit (which describes weekly in this event, not session).
      expect(snapshot?.session).toMatchObject({ percent: 29, severity: 'warning', isActive: true });
    });
  });
});

describe('upgradeSnapshotFromCodeRateLimitEvent', () => {
  it('upgrades both bars with exact percent from unifiedWindows, carrying severity/isActive forward', () => {
    const info = loadRateLimitInfo('code.rate-limit-event.json');
    const previous: LimitSnapshot = {
      capturedAt: '2026-09-04T18:00:00Z',
      source: 'usage',
      session: { percent: 10, resetsAt: '2026-09-04T00:00:00Z', severity: 'warning', isActive: true },
      weekly: { percent: 20, resetsAt: '2026-09-04T00:00:00Z', severity: 'critical', isActive: false },
    };
    const snapshot = upgradeSnapshotFromCodeRateLimitEvent(info, previous, '2026-09-04T18:15:02Z');

    // Real fixture values: five_hour utilization 0.17 -> 17%, seven_day utilization 0.29 -> 29%.
    expect(snapshot?.session).toEqual({
      percent: 17,
      resetsAt: new Date(1788556200 * 1000).toISOString(),
      severity: 'warning',
      isActive: true,
    });
    expect(snapshot?.weekly).toEqual({
      percent: 29,
      resetsAt: new Date(1788613200 * 1000).toISOString(),
      severity: 'critical',
      isActive: false,
    });
  });

  it('defaults severity/isActive when there is no previous snapshot', () => {
    const info = loadRateLimitInfo('code.rate-limit-event.json');
    const snapshot = upgradeSnapshotFromCodeRateLimitEvent(info, null, '2026-09-04T18:15:02Z');

    expect(snapshot?.session).toMatchObject({ severity: 'normal', isActive: false });
    expect(snapshot?.weekly).toMatchObject({ severity: 'normal', isActive: false });
  });

  it('marks the resulting snapshot as rate_limit_event-sourced', () => {
    const info = loadRateLimitInfo('code.rate-limit-event.json');
    const snapshot = upgradeSnapshotFromCodeRateLimitEvent(info, null, '2026-09-04T18:15:02Z');
    expect(snapshot?.source).toBe('rate_limit_event');
  });

  it('carries extraCredits forward from the previous snapshot — rate_limit_event never carries it', () => {
    const info = loadRateLimitInfo('code.rate-limit-event.json');
    const previous: LimitSnapshot = {
      capturedAt: '2026-09-04T18:00:00Z',
      source: 'usage',
      session: null,
      weekly: null,
      extraCredits: { percent: 75, usedAmount: 46.28, limitAmount: 61.55, currency: 'USD' },
    };
    const snapshot = upgradeSnapshotFromCodeRateLimitEvent(info, previous, '2026-09-04T18:15:02Z');
    expect(snapshot?.extraCredits).toEqual(previous.extraCredits);
  });

  it('returns null when unifiedWindows has neither known key', () => {
    const info = loadRateLimitInfo('code.rate-limit-event.json');
    const snapshot = upgradeSnapshotFromCodeRateLimitEvent({ ...info, unifiedWindows: {} }, null, '2026-09-04T18:15:02Z');
    expect(snapshot).toBeNull();
  });
});
