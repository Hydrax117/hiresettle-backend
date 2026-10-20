import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  parseSystemConfigValue,
  serializeSystemConfigValue,
  SYSTEM_CONFIG_DEFINITION_MAP,
  SYSTEM_CONFIG_DEFINITIONS,
  SystemConfigDefinition,
  SystemConfigValidationError,
  SystemConfigValue,
  validateSystemConfigValue,
} from './system-config.definitions';

/** Other replicas pick up an admin change within this window. */
const DEFAULT_REFRESH_MS = 30_000;

export const SYSTEM_CONFIG_AUDIT_ENTITY = 'SystemConfig';

export type SystemConfigSource = 'override' | 'env' | 'default';

export interface SystemConfigView {
  key: string;
  value: SystemConfigValue;
  source: SystemConfigSource;
  type: SystemConfigDefinition['type'];
  description: string;
  defaultValue: SystemConfigValue;
  min?: number | string;
  max?: number | string;
  allowed?: readonly string[];
  updatedAt: Date | null;
}

interface Override {
  value: SystemConfigValue;
  updatedAt: Date;
}

/**
 * Runtime configuration store (#503).
 *
 * Admin overrides live in `system_config` and are cached in memory. `get()`
 * is synchronous and always reads the cache, so consumers see a change the
 * moment it is saved on this instance; other replicas converge on the next
 * refresh (SYSTEM_CONFIG_REFRESH_MS, default 30 s). No restart is needed.
 */
@Injectable()
export class SystemConfigService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SystemConfigService.name);
  private readonly overrides = new Map<string, Override>();
  private refreshTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    await this.refresh().catch((error) =>
      this.logger.warn(`Initial SystemConfig load failed: ${error?.message ?? error}`),
    );
    const intervalMs = Number(this.config.get('SYSTEM_CONFIG_REFRESH_MS', DEFAULT_REFRESH_MS));
    if (intervalMs > 0) {
      this.refreshTimer = setInterval(() => {
        void this.refresh().catch((error) =>
          this.logger.warn(`SystemConfig refresh failed: ${error?.message ?? error}`),
        );
      }, intervalMs);
      this.refreshTimer.unref?.();
    }
  }

  onModuleDestroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  /** Reload every registered override from the database. */
  async refresh(): Promise<void> {
    const rows = await this.prisma.systemConfig.findMany({
      where: { key: { in: SYSTEM_CONFIG_DEFINITIONS.map((d) => d.key) } },
    });
    const next = new Map<string, Override>();
    for (const row of rows) {
      const definition = SYSTEM_CONFIG_DEFINITION_MAP.get(row.key);
      if (!definition) {
        this.logger.warn(`Ignoring unknown config key ${row.key}`);
        continue;
      }
      const value = parseSystemConfigValue(definition, row.value);
      if (value === undefined) {
        this.logger.warn(`Ignoring invalid stored value for ${row.key}: ${row.value}`);
        continue;
      }
      next.set(row.key, { value, updatedAt: row.updatedAt });
    }
    this.overrides.clear();
    for (const [key, override] of next) this.overrides.set(key, override);
  }

  /** Effective value: admin override → environment → default. */
  get<T extends SystemConfigValue = SystemConfigValue>(key: string): T {
    return this.resolve(this.definition(key)).value as T;
  }

  getNumber(key: string): number {
    return Number(this.get(key));
  }

  getBigInt(key: string): bigint {
    return BigInt(this.get<string>(key));
  }

  list(): SystemConfigView[] {
    return SYSTEM_CONFIG_DEFINITIONS.map((definition) => this.view(definition));
  }

  describe(key: string): SystemConfigView {
    return this.view(this.definition(key));
  }

  /**
   * Validate, persist and audit a new value, then apply it in memory.
   * Throws 404 for unknown keys and 400 for invalid values.
   */
  async set(key: string, rawValue: unknown, adminId: string, reason: string): Promise<SystemConfigView> {
    const definition = this.definition(key);
    let value: SystemConfigValue;
    try {
      value = validateSystemConfigValue(definition, rawValue);
    } catch (error) {
      if (error instanceof SystemConfigValidationError) throw new BadRequestException(error.message);
      throw error;
    }

    const previous = this.resolve(definition);
    const serialized = serializeSystemConfigValue(value);

    const row = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.systemConfig.upsert({
        where: { key },
        create: { key, value: serialized },
        update: { value: serialized },
      });
      await tx.auditLog.create({
        data: {
          entityType: SYSTEM_CONFIG_AUDIT_ENTITY,
          entityId: key,
          action: 'SYSTEM_CONFIG_UPDATED',
          oldValue: JSON.stringify({ value: previous.value, source: previous.source }),
          newValue: JSON.stringify({ value }),
          reason,
          changedBy: adminId,
        },
      });
      return saved;
    });

    this.overrides.set(key, { value, updatedAt: row.updatedAt });
    this.logger.log(`SystemConfig ${key} changed by ${adminId}: ${previous.value} -> ${value}`);
    return this.describe(key);
  }

  /** Drop the override so the env/default value applies again. */
  async reset(key: string, adminId: string, reason: string): Promise<SystemConfigView> {
    const definition = this.definition(key);
    const previous = this.resolve(definition);

    await this.prisma.$transaction(async (tx) => {
      await tx.systemConfig.deleteMany({ where: { key } });
      await tx.auditLog.create({
        data: {
          entityType: SYSTEM_CONFIG_AUDIT_ENTITY,
          entityId: key,
          action: 'SYSTEM_CONFIG_RESET',
          oldValue: JSON.stringify({ value: previous.value, source: previous.source }),
          newValue: JSON.stringify({ value: this.fallback(definition).value }),
          reason,
          changedBy: adminId,
        },
      });
    });

    this.overrides.delete(key);
    return this.describe(key);
  }

  private definition(key: string): SystemConfigDefinition {
    const definition = SYSTEM_CONFIG_DEFINITION_MAP.get(key);
    if (!definition) throw new NotFoundException(`Unknown system config key "${key}"`);
    return definition;
  }

  private resolve(definition: SystemConfigDefinition): { value: SystemConfigValue; source: SystemConfigSource } {
    const override = this.overrides.get(definition.key);
    if (override) return { value: override.value, source: 'override' };
    return this.fallback(definition);
  }

  private fallback(definition: SystemConfigDefinition): { value: SystemConfigValue; source: SystemConfigSource } {
    if (definition.envKey) {
      const fromEnv = parseSystemConfigValue(definition, this.config.get(definition.envKey));
      if (fromEnv !== undefined) return { value: fromEnv, source: 'env' };
    }
    return { value: definition.defaultValue, source: 'default' };
  }

  private view(definition: SystemConfigDefinition): SystemConfigView {
    const resolved = this.resolve(definition);
    return {
      key: definition.key,
      value: resolved.value,
      source: resolved.source,
      type: definition.type,
      description: definition.description,
      defaultValue: definition.defaultValue,
      ...(definition.min !== undefined && { min: definition.min }),
      ...(definition.max !== undefined && { max: definition.max }),
      ...(definition.allowed && { allowed: definition.allowed }),
      updatedAt: this.overrides.get(definition.key)?.updatedAt ?? null,
    };
  }
}
