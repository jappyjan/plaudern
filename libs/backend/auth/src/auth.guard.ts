import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { DEFAULT_USER_ID } from '@plaudern/persistence';
import { parseCookies, resolveAuthConfig, SESSION_COOKIE } from './auth.config';
import { IS_PUBLIC_KEY } from './decorators';
import { SessionService, type AuthenticatedUser } from './session.service';

/**
 * Global guard: every route requires a valid session cookie unless marked
 * @Public(). With AUTH_DISABLED=true the instance runs in the old
 * single-user mode and every request acts as DEFAULT_USER_ID.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined>; user?: AuthenticatedUser }>();

    if (resolveAuthConfig(this.config).disabled) {
      request.user = { id: DEFAULT_USER_ID, username: 'default' };
      return true;
    }

    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    const user = token ? await this.sessions.resolveUser(token) : null;
    if (user) request.user = user;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    if (!user) throw new UnauthorizedException('authentication required');
    return true;
  }
}
