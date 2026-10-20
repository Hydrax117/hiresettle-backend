import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModuleOptions, JwtSecretRequestType } from '@nestjs/jwt';
import { createPrivateKey, createPublicKey, KeyObject } from 'crypto';
import { readFileSync } from 'fs';

/** Asymmetric algorithm used for access/refresh token signatures (#481). */
export const JWT_ASYMMETRIC_ALGORITHM = 'RS256';
const LEGACY_ALGORITHM = 'HS256';
const MIN_RSA_MODULUS_BITS = 2048;

/** One entry of JWT_SIGNING_KEYS. Only the active key needs a private key. */
export interface JwtSigningKeyConfig {
  kid: string;
  privateKey?: string;
  publicKey?: string;
}

export interface JsonWebKey {
  kty: string;
  kid: string;
  use: 'sig';
  alg: string;
  n: string;
  e: string;
}

interface LoadedKey {
  kid: string;
  privateKey: KeyObject | null;
  publicKey: KeyObject;
}

/**
 * Holds the RS256 signing keys and decides which key signs and which keys
 * verify (#481).
 *
 * Rotation model:
 *   - JWT_SIGNING_KEYS is a JSON array of `{ kid, privateKey?, publicKey? }`
 *     (PEM; literal "\n" escapes are accepted). JWT_SIGNING_KEYS_FILE may
 *     point to a file with the same JSON, e.g. a mounted Kubernetes Secret.
 *   - JWT_ACTIVE_KID selects the key that signs new tokens; it defaults to
 *     the first entry that has a private key.
 *   - Every listed key verifies tokens carrying its `kid`, so a predecessor
 *     key stays trusted (and published in the JWKS) until it is removed from
 *     the list — keep it for at least the longest token lifetime.
 *
 * Legacy mode: when no asymmetric keys are configured, tokens are signed and
 * verified with HS256 + JWT_SECRET exactly as before. Setting
 * JWT_ACCEPT_LEGACY_HS256=true keeps accepting HS256 tokens after migrating,
 * so sessions issued before the switch survive until they expire.
 */
@Injectable()
export class JwtKeyStore {
  private readonly logger = new Logger(JwtKeyStore.name);
  private readonly keys = new Map<string, LoadedKey>();
  private readonly activeKey: LoadedKey | null;
  private readonly legacySecret: string | null;
  private readonly acceptLegacy: boolean;

  constructor(private readonly config: ConfigService) {
    for (const entry of this.readKeyConfig()) {
      const loaded = JwtKeyStore.loadKey(entry);
      if (this.keys.has(loaded.kid)) {
        throw new Error(`Duplicate JWT signing key id "${loaded.kid}"`);
      }
      this.keys.set(loaded.kid, loaded);
    }

    this.activeKey = this.resolveActiveKey();
    this.legacySecret = this.config.get<string>('JWT_SECRET') || null;
    this.acceptLegacy =
      !this.activeKey || isTruthy(this.config.get<string>('JWT_ACCEPT_LEGACY_HS256'));

    if (!this.activeKey) {
      this.logger.warn(
        'No JWT_SIGNING_KEYS configured — falling back to HS256 with JWT_SECRET. ' +
          'Configure RS256 keys to publish a JWKS for downstream services.',
      );
    }
  }

  /** True when tokens are signed with an asymmetric key and a `kid`. */
  get isAsymmetric(): boolean {
    return this.activeKey !== null;
  }

  get activeKid(): string | null {
    return this.activeKey?.kid ?? null;
  }

  /** Algorithms accepted when verifying a token. */
  verifyAlgorithms(): string[] {
    const algorithms: string[] = [];
    if (this.keys.size > 0) algorithms.push(JWT_ASYMMETRIC_ALGORITHM);
    if (this.acceptLegacy && this.legacySecret) algorithms.push(LEGACY_ALGORITHM);
    return algorithms;
  }

  /** Key used to sign new tokens. */
  signingKey(): KeyObject | string {
    if (this.activeKey) return this.activeKey.privateKey!;
    if (!this.legacySecret) throw new Error('JWT_SECRET is not configured');
    return this.legacySecret;
  }

  /**
   * Pick the verification key for a raw token from its header. The key is
   * chosen by `alg` + `kid`, never by trying every key, so an RS256 public
   * key can never be used as an HMAC secret (algorithm confusion).
   */
  verificationKeyFor(rawToken: string): KeyObject | string {
    const header = decodeHeader(rawToken);
    if (!header) throw new Error('Malformed JWT');

    if (header.alg === JWT_ASYMMETRIC_ALGORITHM) {
      const key = header.kid ? this.keys.get(header.kid) : undefined;
      if (!key) throw new Error(`Unknown JWT key id "${header.kid ?? ''}"`);
      return key.publicKey;
    }

    if (header.alg === LEGACY_ALGORITHM && this.acceptLegacy && this.legacySecret) {
      return this.legacySecret;
    }

    throw new Error(`Unsupported JWT algorithm "${header.alg}"`);
  }

  /** Public keys for `/.well-known/jwks.json`; empty in legacy HS256 mode. */
  jwks(): { keys: JsonWebKey[] } {
    return {
      keys: [...this.keys.values()].map((key) => {
        const jwk = key.publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };
        return {
          kty: jwk.kty,
          kid: key.kid,
          use: 'sig',
          alg: JWT_ASYMMETRIC_ALGORITHM,
          n: jwk.n,
          e: jwk.e,
        };
      }),
    };
  }

  /**
   * Options for JwtModule / standalone JwtService instances so every signer
   * and verifier in the app shares the same key material and rules.
   */
  jwtModuleOptions(expiresIn: string | number = '15m'): JwtModuleOptions {
    return {
      secretOrKeyProvider: (requestType: JwtSecretRequestType, tokenOrPayload: unknown) =>
        requestType === JwtSecretRequestType.SIGN
          ? (this.signingKey() as any)
          : (this.verificationKeyFor(String(tokenOrPayload)) as any),
      signOptions: {
        expiresIn,
        algorithm: this.activeKey ? JWT_ASYMMETRIC_ALGORITHM : LEGACY_ALGORITHM,
        ...(this.activeKey && { keyid: this.activeKey.kid }),
      },
      verifyOptions: { algorithms: this.verifyAlgorithms() as any },
    };
  }

  private readKeyConfig(): JwtSigningKeyConfig[] {
    const file = this.config.get<string>('JWT_SIGNING_KEYS_FILE');
    const raw = file ? readFileSync(file, 'utf8') : this.config.get<string>('JWT_SIGNING_KEYS');
    if (!raw || !raw.trim()) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('JWT_SIGNING_KEYS must be a JSON array of { kid, privateKey?, publicKey? }');
    }
    if (!Array.isArray(parsed)) {
      throw new Error('JWT_SIGNING_KEYS must be a JSON array');
    }
    return parsed as JwtSigningKeyConfig[];
  }

  private resolveActiveKey(): LoadedKey | null {
    if (this.keys.size === 0) return null;

    const requested = this.config.get<string>('JWT_ACTIVE_KID');
    const active = requested
      ? this.keys.get(requested)
      : [...this.keys.values()].find((key) => key.privateKey);

    if (!active) {
      throw new Error(
        requested
          ? `JWT_ACTIVE_KID "${requested}" does not match any JWT_SIGNING_KEYS entry`
          : 'At least one JWT_SIGNING_KEYS entry must include a privateKey',
      );
    }
    if (!active.privateKey) {
      throw new Error(`Active JWT key "${active.kid}" has no privateKey`);
    }
    return active;
  }

  private static loadKey(entry: JwtSigningKeyConfig): LoadedKey {
    if (!entry || typeof entry.kid !== 'string' || !entry.kid.trim()) {
      throw new Error('Every JWT_SIGNING_KEYS entry needs a non-empty "kid"');
    }
    if (!entry.privateKey && !entry.publicKey) {
      throw new Error(`JWT key "${entry.kid}" needs a privateKey or publicKey`);
    }

    const privateKey = entry.privateKey ? createPrivateKey(normalizePem(entry.privateKey)) : null;
    const publicKey = entry.publicKey
      ? createPublicKey(normalizePem(entry.publicKey))
      : createPublicKey(privateKey!);

    const modulusLength = publicKey.asymmetricKeyDetails?.modulusLength ?? 0;
    if (publicKey.asymmetricKeyType !== 'rsa' || modulusLength < MIN_RSA_MODULUS_BITS) {
      throw new Error(
        `JWT key "${entry.kid}" must be an RSA key of at least ${MIN_RSA_MODULUS_BITS} bits`,
      );
    }

    return { kid: entry.kid, privateKey, publicKey };
  }
}

function normalizePem(pem: string): string {
  return pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
}

function isTruthy(value?: string): boolean {
  return ['true', '1', 'yes'].includes(String(value ?? '').trim().toLowerCase());
}

/** Decode a JWT header without verifying it. */
export function decodeHeader(rawToken: string): { alg?: string; kid?: string } | null {
  const [encoded] = String(rawToken ?? '').split('.');
  if (!encoded) return null;
  try {
    const header = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return header && typeof header === 'object' ? header : null;
  } catch {
    return null;
  }
}
