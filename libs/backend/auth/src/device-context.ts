import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { DeviceKind } from '@plaudern/persistence';

/** The authenticated caller, attached to the request by DeviceAuthGuard. */
export interface DeviceContext {
  deviceId: string;
  userId: string;
  kind: DeviceKind;
}

export const CurrentDevice = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): DeviceContext => {
    const request = ctx.switchToHttp().getRequest();
    return request.deviceContext as DeviceContext;
  },
);
