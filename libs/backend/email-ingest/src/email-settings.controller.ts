import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { updateEmailSettingsRequestSchema, type EmailSettingsDto } from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { EmailSettingsService } from './email-settings.service';

@Controller({ path: 'settings/email', version: '1' })
export class EmailSettingsController {
  constructor(private readonly settings: EmailSettingsService) {}

  @Get()
  async get(@CurrentUser() user: AuthenticatedUser): Promise<EmailSettingsDto> {
    return this.settings.toDto(await this.settings.getEntity(user.id));
  }

  @Put()
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<EmailSettingsDto> {
    const req = updateEmailSettingsRequestSchema.parse(body);
    return this.settings.toDto(await this.settings.setEnabled(user.id, req.enabled));
  }

  /** Generates the address on first call, rotates it (invalidating the old one) on every call after. */
  @Post('rotate')
  async rotate(@CurrentUser() user: AuthenticatedUser): Promise<EmailSettingsDto> {
    return this.settings.toDto(await this.settings.generateOrRotateToken(user.id));
  }
}
