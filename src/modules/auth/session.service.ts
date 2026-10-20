import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { RefreshToken, User } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SecurityEventsService } from '../../common/security-events/security-events.service';
import { RequestMeta } from './auth.service';

const REFRESH_TOKEN_DAYS = 7;
const DEFAULT_IDLE_SESSION_WINDOW_DAYS = 7;
const ACTION_LOGOUT = 'LOGOUT' as const;

/**
 * SessionService — manages JWT issuance and refresh-token lifecycle (#444).
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly securityEvents: SecurityEventsService,
  ) {}

  async issueTokenPair(user: User) {
    const familyId = randomBytes(24).toString('hex');
    const refreshToken = await this.signRefreshToken(user, familyId);

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashRefreshToken(refreshToken),
        familyId,
        expiresAt: this.refreshExpiryDate(),
        lastUsedAt: new Date(),
      },
    });

    const { passwordHash, webhookSecret, ...safeUser } = user as any;
    return { accessToken: this.signAccessToken(user), refreshToken, user: safeUser };
  }

  async refresh(refreshToken: string) {
    const tokenHash = this.hashRefreshToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored) throw new UnauthorizedException('Invalid refresh token');

    const now = new Date();

    if (stored.consumedAt) {
      await this.revokeFamily(stored.familyId);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (stored.revokedAt || stored.expiresAt <= now) {
      throw new UnauthorizedException('Refresh token is no longer valid');
    }

    if (this.isSessionIdle(stored as any, now)) {
      throw new UnauthorizedException('Session has expired due to inactivity');
    }

    const nextRefreshToken = await this.signRefreshToken(stored.user, stored.familyId);
    const nextExpiresAt = this.refreshExpiryDate();

    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.refreshToken.updateMany({
        where: { id: stored.id, consumedAt: null, revokedAt: null },
        data: { consumedAt: now, lastUsedAt: now },
      });

      if (consumed.count !== 1) {
        await tx.refreshToken.updateMany({
          where: { familyId: stored.familyId, revokedAt: null },
          data: { revokedAt: now },
        });
        throw new UnauthorizedException('Refresh token reuse detected');
      }

      await tx.refreshToken.create({
        data: {
          userId: stored.userId,
          tokenHash: this.hashRefreshToken(nextRefreshToken),
          familyId: stored.familyId,
          expiresAt: nextExpiresAt,
          lastUsedAt: now,
        },
      });
    });

    const { passwordHash, webhookSecret, ...safeUser } = stored.user as any;
    return { accessToken: this.signAccessToken(stored.user), refreshToken: nextRefreshToken, user: safeUser };
  }

  async logout(refreshToken: string, meta: RequestMeta = {}) {
    const tokenHash = this.hashRefreshToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (stored && !stored.revokedAt) {
      await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    }

    await this.securityEvents.log({ userId: stored?.userId, action: ACTION_LOGOUT, ip: meta.ip, userAgent: meta.userAgent });
    return { revoked: true };
  }

  async getSessions(userId: string) {
    const now = new Date();
    const sessions = await this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });

    return sessions.map((s) => ({
      id: s.id,
      familyId: s.familyId,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      lastUsedAt: s.lastUsedAt,
      isCurrent: s.consumedAt === null,
    }));
  }

  async revokeSession(sessionId: string, userId: string, currentRefreshToken?: string) {
    const session = await this.prisma.refreshToken.findUnique({ where: { id: sessionId } });

    if (!session) throw new BadRequestException('Session not found');
    if (session.userId !== userId) throw new ForbiddenException('You can only revoke your own sessions');
    if (session.revokedAt) throw new BadRequestException('Session already revoked');

    await this.prisma.refreshToken.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });

    let isCurrentSession = false;
    if (currentRefreshToken) {
      isCurrentSession = session.tokenHash === this.hashRefreshToken(currentRefreshToken);
    }

    return { revoked: true, isCurrentSession };
  }

  // ── Token helpers ─────────────────────────────────────────────────────────

  signAccessToken(user: User): string {
    return this.jwt.sign(
      { sub: user.id, email: user.email, stellarAddress: user.stellarAddress, role: user.role, type: 'access' },
      { expiresIn: this.config.get<string>('JWT_ACCESS_EXPIRES_IN', '15m') },
    );
  }

  async signRefreshToken(user: User, familyId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: user.id, familyId, type: 'refresh' },
      { expiresIn: this.config.get<string>('JWT_REFRESH_EXPIRES_IN', '7d') },
    );
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  refreshExpiryDate(): Date {
    const days = this.config.get<number>('JWT_REFRESH_EXPIRES_DAYS', REFRESH_TOKEN_DAYS);
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  private isSessionIdle(token: Pick<RefreshToken, 'lastUsedAt' | 'createdAt'>, now: Date): boolean {
    const idleWindowDays = this.config.get<number>('IDLE_SESSION_WINDOW_DAYS', DEFAULT_IDLE_SESSION_WINDOW_DAYS);
    const lastActivity = token.lastUsedAt ?? token.createdAt;
    const idleCutoff = new Date(now.getTime() - idleWindowDays * 24 * 60 * 60 * 1000);
    return lastActivity < idleCutoff;
  }

  private async revokeFamily(familyId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
