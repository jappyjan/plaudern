import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { Public } from '@plaudern/auth';

@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  /** Liveness probe — must work without a session. */
  @Public()
  @Get('health')
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'plaudern-api' };
  }
}
