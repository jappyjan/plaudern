import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';

@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  @Get('health')
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'plaudern-api' };
  }
}
