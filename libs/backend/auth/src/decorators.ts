import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from './session.service';

export const IS_PUBLIC_KEY = 'plaudern:isPublic';

/** Opts a route out of the global session guard (auth ceremonies, health). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** The authenticated user set on the request by SessionAuthGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!request.user) {
      // Guard misconfiguration — a protected handler without a resolved user.
      throw new Error('CurrentUser used on a route that did not pass the auth guard');
    }
    return request.user;
  },
);
