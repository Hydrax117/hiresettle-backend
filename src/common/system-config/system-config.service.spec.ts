import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SystemConfigService } from './system-config.service';
import { validateSystemConfigValue, SYSTEM_CONFIG_DEFINITION_MAP } from './system-config.definitions';

function makePrisma(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial).map(([key, value]) => [key, { key, value, updatedAt: new Date() }]));
  const auditLogs: any[] = [];
  const prisma: any = {
    systemConfig: {
      findMany: jest.fn(async ({ where }: any) => [...rows.values()].filter((r) => where.key.in.includes(r.key))),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const row = { key: where.key, value: rows.has(where.key) ? update.value : create.value, updatedAt: new Date() };
        rows.set(where.key, row);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }: any) => ({ count: rows.delete(where.key) ? 1 : 0 })),
    },
    auditLog: { create: jest.fn(async ({ data }: any) => auditLogs.push(data)) },
    $transaction: jest.fn(async (fn: (tx: any) => unknown) => fn(prisma)),
  };
  return { prisma, rows, auditLogs };
}

function makeService(env: Record<string, unknown> = {}, stored: Record<string, string> = {}) {
  const fake = makePrisma(stored);
  const config = { get: jest.fn((key: string, fallback?: unknown) => (key in env ? env[key] : fallback)) } as any;
  return { service: new SystemConfigService(fake.prisma, config), ...fake };
}

describe('SystemConfigService (#503)', () => {
  it('resolves override → env → default', async () => {
    const { service } = makeService(
      { DISPUTE_SLA_REVIEW_HOURS: 48, SYSTEM_CONFIG_REFRESH_MS: 0 },
      { 'disputes.slaAssignmentHours': '12' },
    );
    await service.onModuleInit();

    expect(service.describe('disputes.slaAssignmentHours')).toMatchObject({ value: 12, source: 'override' });
    expect(service.describe('disputes.slaReviewHours')).toMatchObject({ value: 48, source: 'env' });
    expect(service.describe('disputes.slaAppealHours')).toMatchObject({ value: 72, source: 'default' });
  });

  it('ignores invalid stored or env values instead of crashing consumers', async () => {
    const { service } = makeService(
      { DISPUTE_SLA_REVIEW_HOURS: 'abc', SYSTEM_CONFIG_REFRESH_MS: 0 },
      { 'disputes.slaAssignmentHours': '99999' },
    );
    await service.onModuleInit();

    expect(service.getNumber('disputes.slaAssignmentHours')).toBe(24);
    expect(service.getNumber('disputes.slaReviewHours')).toBe(72);
  });

  it('applies an update immediately, persists it and writes an audit log', async () => {
    const { service, rows, auditLogs } = makeService({ SYSTEM_CONFIG_REFRESH_MS: 0 });
    await service.onModuleInit();

    const view = await service.set('disputes.slaReviewHours', 96, 'admin-1', 'Holiday backlog');

    expect(view).toMatchObject({ value: 96, source: 'override' });
    expect(service.getNumber('disputes.slaReviewHours')).toBe(96);
    expect(rows.get('disputes.slaReviewHours')!.value).toBe('96');
    expect(auditLogs).toEqual([
      {
        entityType: 'SystemConfig',
        entityId: 'disputes.slaReviewHours',
        action: 'SYSTEM_CONFIG_UPDATED',
        oldValue: JSON.stringify({ value: 72, source: 'default' }),
        newValue: JSON.stringify({ value: 96 }),
        reason: 'Holiday backlog',
        changedBy: 'admin-1',
      },
    ]);
  });

  it('rejects unknown keys with 404', async () => {
    const { service } = makeService();

    expect(() => service.describe('internal.cursor')).toThrow(NotFoundException);
    await expect(service.set('internal.cursor', 1, 'admin-1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    ['a string for an integer', 'disputes.slaReviewHours', '96'],
    ['a float', 'disputes.slaReviewHours', 1.5],
    ['below the minimum', 'disputes.slaReviewHours', 0],
    ['above the maximum', 'disputes.slaReviewHours', 721],
    ['a negative stroop amount', 'stellar.balanceAlertThresholdStroops', '-1'],
    ['a decimal stroop amount', 'stellar.balanceAlertThresholdStroops', '1.5'],
    ['an object', 'milestones.placementReminderDays', { days: 3 }],
  ])('rejects %s with 400 and writes nothing', async (_label, key, value) => {
    const { service, rows, auditLogs } = makeService();

    await expect(service.set(key, value, 'admin-1', 'test')).rejects.toBeInstanceOf(BadRequestException);
    expect(rows.size).toBe(0);
    expect(auditLogs).toHaveLength(0);
  });

  it('accepts stroop amounts as strings and exposes them as bigint', async () => {
    const { service } = makeService();

    await service.set('stellar.balanceAlertThresholdStroops', '50000000', 'admin-1', 'Raise alert floor');

    expect(service.getBigInt('stellar.balanceAlertThresholdStroops')).toBe(50_000_000n);
  });

  it('reset() removes the override, falls back and audits', async () => {
    const { service, auditLogs } = makeService({ PLACEMENT_MILESTONE_REMINDER_DAYS: 5 });
    await service.set('milestones.placementReminderDays', 2, 'admin-1', 'Shorter');

    const view = await service.reset('milestones.placementReminderDays', 'admin-1', 'Back to env');

    expect(view).toMatchObject({ value: 5, source: 'env' });
    expect(auditLogs[1]).toMatchObject({ action: 'SYSTEM_CONFIG_RESET', changedBy: 'admin-1' });
  });

  it('refresh() picks up changes written by another replica', async () => {
    const { service, rows } = makeService({ SYSTEM_CONFIG_REFRESH_MS: 0 });
    await service.onModuleInit();

    rows.set('disputes.appealWindowHours', { key: 'disputes.appealWindowHours', value: '0', updatedAt: new Date() });
    await service.refresh();

    expect(service.getNumber('disputes.appealWindowHours')).toBe(0);
  });

  it('lists only registered settings', () => {
    const { service } = makeService();
    expect(service.list().map((s) => s.key)).toEqual([...SYSTEM_CONFIG_DEFINITION_MAP.keys()]);
  });
});

describe('validateSystemConfigValue', () => {
  it('validates boolean and enumerated string settings', () => {
    const bool = { key: 'x', type: 'boolean' as const, description: '', defaultValue: false };
    expect(validateSystemConfigValue(bool, true)).toBe(true);
    expect(() => validateSystemConfigValue(bool, 'true')).toThrow();

    const str = { key: 'y', type: 'string' as const, description: '', defaultValue: 'a', allowed: ['a', 'b'], maxLength: 1 };
    expect(validateSystemConfigValue(str, 'b')).toBe('b');
    expect(() => validateSystemConfigValue(str, 'c')).toThrow(/one of/);
  });
});
