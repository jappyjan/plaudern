import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { DeviceContext } from './device-context';

/**
 * Minimal device auth (plan §2): a bearer/`x-device-key` API key identifies the
 * device and, transitively, the user that owns the inbox items it pushes.
 */
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const apiKey = this.extractApiKey(request);
    if (!apiKey) throw new UnauthorizedException('missing device API key');

    const device = await this.auth.findDeviceByApiKey(apiKey);
    if (!device) throw new UnauthorizedException('invalid device API key');

    const deviceContext: DeviceContext = {
      deviceId: device.id,
      userId: device.userId,
      kind: device.kind,
    };
    request.deviceContext = deviceContext;
    return true;
  }

  private extractApiKey(request: {
    headers: Record<string, string | string[] | undefined>;
  }): string | null {
    const header = request.headers['x-device-key'];
    if (typeof header === 'string' && header.length > 0) return header;

    const auth = request.headers['authorization'];
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
      return auth.slice(7).trim();
    }
    return null;
  }
}
