import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import type { AuthStatusDto, PasskeyDto } from '@plaudern/contracts';
import {
  DEFAULT_USER_ID,
  PasskeyCredentialEntity,
  UserEntity,
} from '@plaudern/persistence';
import { resolveAuthConfig } from './auth.config';
import { ChallengeStore } from './challenge-store';
import { SessionService, toAuthenticatedUser, type AuthenticatedUser } from './session.service';

/**
 * Passkey-only authentication (no passwords anywhere). Registration and login
 * are the two standard WebAuthn ceremonies; login is usernameless via
 * discoverable credentials (residentKey: required), so signing in is a single
 * browser prompt. Each verified ceremony ends in a cookie session.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(PasskeyCredentialEntity)
    private readonly credentials: Repository<PasskeyCredentialEntity>,
    private readonly challenges: ChallengeStore,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
  ) {}

  async status(): Promise<AuthStatusDto> {
    const cfg = resolveAuthConfig(this.config);
    const usersExist = (await this.users.count()) > 0;
    return {
      usersExist,
      allowRegistration: !usersExist || cfg.allowRegistration,
      authDisabled: cfg.disabled,
    };
  }

  // ---------------------------------------------------------------- register

  async registerOptions(
    username: string,
  ): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }> {
    const cfg = resolveAuthConfig(this.config);
    const usersExist = (await this.users.count()) > 0;
    if (usersExist && !cfg.allowRegistration) {
      throw new ForbiddenException('registration is disabled on this instance');
    }
    if (await this.users.findOne({ where: { username } })) {
      throw new ConflictException('this username is already taken');
    }

    const options = await generateRegistrationOptions({
      rpName: cfg.rpName,
      rpID: cfg.rpId,
      userName: username,
      attestationType: 'none',
      authenticatorSelection: {
        // Discoverable credential so login works without typing a username.
        residentKey: 'required',
        userVerification: 'preferred',
      },
    });
    const challengeId = this.challenges.put({
      challenge: options.challenge,
      username,
      webauthnUserId: options.user.id,
    });
    return { options, challengeId };
  }

  async registerVerify(
    challengeId: string | undefined,
    response: RegistrationResponseJSON,
    label: string | undefined,
  ): Promise<AuthenticatedUser> {
    const pending = this.challenges.take(challengeId);
    if (!pending?.username || !pending.webauthnUserId) {
      throw new BadRequestException('registration challenge expired — try again');
    }
    const registrationInfo = await this.verifyAttestation(response, pending.challenge);

    // The count-then-insert race on "first user" or a username collides on the
    // unique indexes and surfaces as 409 instead of corrupting ownership.
    const user = this.users.create({
      id: (await this.users.count()) === 0 ? DEFAULT_USER_ID : randomUUID(),
      username: pending.username,
      webauthnUserId: pending.webauthnUserId,
    });
    try {
      await this.users.insert(user);
    } catch {
      throw new ConflictException('this username is already taken');
    }
    await this.saveCredential(user.id, registrationInfo, response, label);
    this.logger.log(`registered user '${user.username}' (${user.id})`);
    return toAuthenticatedUser(user);
  }

  // ------------------------------------------------------------ add passkey

  async addPasskeyOptions(
    user: AuthenticatedUser,
  ): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }> {
    const cfg = resolveAuthConfig(this.config);
    const entity = await this.users.findOne({ where: { id: user.id } });
    if (!entity) throw new UnauthorizedException('user no longer exists');
    const existing = await this.credentials.find({ where: { userId: user.id } });

    const options = await generateRegistrationOptions({
      rpName: cfg.rpName,
      rpID: cfg.rpId,
      userName: entity.username,
      userID: new Uint8Array(Buffer.from(entity.webauthnUserId, 'base64url')),
      attestationType: 'none',
      excludeCredentials: existing.map((cred) => ({
        id: cred.id,
        transports: (cred.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'preferred',
      },
    });
    const challengeId = this.challenges.put({ challenge: options.challenge, userId: user.id });
    return { options, challengeId };
  }

  async addPasskeyVerify(
    user: AuthenticatedUser,
    challengeId: string | undefined,
    response: RegistrationResponseJSON,
    label: string | undefined,
  ): Promise<PasskeyDto> {
    const pending = this.challenges.take(challengeId);
    if (!pending || pending.userId !== user.id) {
      throw new BadRequestException('passkey challenge expired — try again');
    }
    const registrationInfo = await this.verifyAttestation(response, pending.challenge);
    const saved = await this.saveCredential(user.id, registrationInfo, response, label);
    return toPasskeyDto(saved);
  }

  // ------------------------------------------------------------------ login

  async loginOptions(): Promise<{
    options: PublicKeyCredentialRequestOptionsJSON;
    challengeId: string;
  }> {
    const cfg = resolveAuthConfig(this.config);
    const options = await generateAuthenticationOptions({
      rpID: cfg.rpId,
      // Empty allowCredentials => the browser offers the user's discoverable
      // passkeys for this RP — usernameless login.
      allowCredentials: [],
      userVerification: 'preferred',
    });
    const challengeId = this.challenges.put({ challenge: options.challenge });
    return { options, challengeId };
  }

  async loginVerify(
    challengeId: string | undefined,
    response: AuthenticationResponseJSON,
  ): Promise<AuthenticatedUser> {
    const pending = this.challenges.take(challengeId);
    if (!pending) throw new BadRequestException('login challenge expired — try again');

    const credential = await this.credentials.findOne({
      where: { id: response.id },
      relations: { user: true },
    });
    if (!credential || !credential.user) {
      throw new UnauthorizedException('unknown passkey');
    }

    const cfg = resolveAuthConfig(this.config);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: cfg.origins,
        expectedRPID: cfg.rpId,
        credential: toWebAuthnCredential(credential),
        requireUserVerification: false,
      });
    } catch (err) {
      throw new UnauthorizedException(
        `passkey verification failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (!verification.verified) throw new UnauthorizedException('passkey verification failed');

    await this.credentials.update(
      { id: credential.id },
      {
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: new Date().toISOString(),
      },
    );
    return toAuthenticatedUser(credential.user);
  }

  // --------------------------------------------------------------- passkeys

  async listPasskeys(userId: string): Promise<PasskeyDto[]> {
    const rows = await this.credentials.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map(toPasskeyDto);
  }

  async deletePasskey(userId: string, credentialId: string): Promise<void> {
    const row = await this.credentials.findOne({ where: { id: credentialId, userId } });
    if (!row) throw new NotFoundException('passkey not found');
    if ((await this.credentials.count({ where: { userId } })) <= 1) {
      throw new BadRequestException(
        'cannot remove the last passkey — it is the only way to sign in',
      );
    }
    await this.credentials.delete({ id: credentialId, userId });
  }

  // ---------------------------------------------------------------- helpers

  private async verifyAttestation(response: RegistrationResponseJSON, challenge: string) {
    const cfg = resolveAuthConfig(this.config);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: cfg.origins,
        expectedRPID: cfg.rpId,
        requireUserVerification: false,
      });
    } catch (err) {
      throw new BadRequestException(
        `passkey verification failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new BadRequestException('passkey verification failed');
    }
    return verification.registrationInfo;
  }

  private async saveCredential(
    userId: string,
    registrationInfo: NonNullable<
      Awaited<ReturnType<typeof verifyRegistrationResponse>>['registrationInfo']
    >,
    response: RegistrationResponseJSON,
    label: string | undefined,
  ): Promise<PasskeyCredentialEntity> {
    const { credential, credentialDeviceType, credentialBackedUp } = registrationInfo;
    const row = this.credentials.create({
      id: credential.id,
      userId,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports ?? response.response.transports ?? null,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      label: label ?? null,
    });
    try {
      return await this.credentials.save(row);
    } catch {
      // Credential ids are globally unique — a collision means it is already
      // registered (to this or another account).
      throw new ConflictException('this passkey is already registered');
    }
  }
}

function toWebAuthnCredential(row: PasskeyCredentialEntity): WebAuthnCredential {
  return {
    id: row.id,
    publicKey: new Uint8Array(Buffer.from(row.publicKey, 'base64url')),
    counter: row.counter,
    transports: (row.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
  };
}

function toPasskeyDto(row: PasskeyCredentialEntity): PasskeyDto {
  return {
    id: row.id,
    label: row.label,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt,
  };
}
