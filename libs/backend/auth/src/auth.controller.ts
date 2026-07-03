import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  registerOptionsRequestSchema,
  webauthnVerifyRequestSchema,
  type AuthStatusDto,
  type MeResponse,
  type PasskeyDto,
  type PasskeyListResponse,
} from '@plaudern/contracts';
import {
  CHALLENGE_COOKIE,
  CHALLENGE_TTL_MS,
  parseCookies,
  resolveAuthConfig,
  SESSION_COOKIE,
} from './auth.config';
import { AuthService } from './auth.service';
import { CurrentUser, Public } from './decorators';
import { SessionService, type AuthenticatedUser } from './session.service';

/**
 * Passkey ceremonies + session lifecycle. Each ceremony is two calls: the
 * "options" endpoint hands the browser WebAuthn options (challenge bound to
 * the browser via a short-lived cookie), the "verify" endpoint checks the
 * authenticator's answer. Successful register/login verify sets the session
 * cookie.
 */
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Get('status')
  status(): Promise<AuthStatusDto> {
    return this.auth.status();
  }

  @Public()
  @Post('register/options')
  async registerOptions(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ options: unknown }> {
    this.rejectWhenDisabled();
    // No global ZodError filter exists, so a raw .parse() would surface as 500.
    const parsed = registerOptionsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid username');
    }
    const { options, challengeId } = await this.auth.registerOptions(parsed.data.username);
    this.setChallengeCookie(req, res, challengeId);
    return { options };
  }

  @Public()
  @Post('register/verify')
  async registerVerify(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    this.rejectWhenDisabled();
    const { response, label } = this.parseVerify(body);
    const user = await this.auth.registerVerify(
      this.takeChallengeCookie(req, res),
      response as unknown as RegistrationResponseJSON,
      label,
    );
    await this.startSession(req, res, user.id);
    return { user };
  }

  @Public()
  @Post('login/options')
  async loginOptions(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ options: unknown }> {
    this.rejectWhenDisabled();
    const { options, challengeId } = await this.auth.loginOptions();
    this.setChallengeCookie(req, res, challengeId);
    return { options };
  }

  @Public()
  @Post('login/verify')
  async loginVerify(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    this.rejectWhenDisabled();
    const { response } = this.parseVerify(body);
    const user = await this.auth.loginVerify(
      this.takeChallengeCookie(req, res),
      response as unknown as AuthenticationResponseJSON,
    );
    await this.startSession(req, res, user.id);
    return { user };
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): MeResponse {
    return { user };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) await this.sessions.deleteByToken(token);
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/' });
  }

  @Get('passkeys')
  async listPasskeys(@CurrentUser() user: AuthenticatedUser): Promise<PasskeyListResponse> {
    return { passkeys: await this.auth.listPasskeys(user.id) };
  }

  @Post('passkeys/options')
  async addPasskeyOptions(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ options: unknown }> {
    this.rejectWhenDisabled();
    const { options, challengeId } = await this.auth.addPasskeyOptions(user);
    this.setChallengeCookie(req, res, challengeId);
    return { options };
  }

  @Post('passkeys/verify')
  async addPasskeyVerify(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PasskeyDto> {
    this.rejectWhenDisabled();
    const { response, label } = this.parseVerify(body);
    return this.auth.addPasskeyVerify(
      user,
      this.takeChallengeCookie(req, res),
      response as unknown as RegistrationResponseJSON,
      label,
    );
  }

  @Delete('passkeys/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deletePasskey(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.auth.deletePasskey(user.id, id);
  }

  // ---------------------------------------------------------------- helpers

  private parseVerify(body: unknown) {
    const parsed = webauthnVerifyRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('invalid verification payload');
    return parsed.data;
  }

  private rejectWhenDisabled(): void {
    if (resolveAuthConfig(this.config).disabled) {
      throw new BadRequestException('authentication is disabled on this instance (AUTH_DISABLED)');
    }
  }

  private async startSession(req: Request, res: Response, userId: string): Promise<void> {
    const { token, maxAgeMs } = await this.sessions.createSession(userId);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecureRequest(req),
      path: '/',
      maxAge: maxAgeMs,
    });
  }

  private setChallengeCookie(req: Request, res: Response, challengeId: string): void {
    res.cookie(CHALLENGE_COOKIE, challengeId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecureRequest(req),
      path: '/',
      maxAge: CHALLENGE_TTL_MS,
    });
  }

  private takeChallengeCookie(req: Request, res: Response): string | undefined {
    const id = parseCookies(req.headers.cookie)[CHALLENGE_COOKIE];
    res.clearCookie(CHALLENGE_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/' });
    return id;
  }
}

function isSecureRequest(req: Request): boolean {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}
