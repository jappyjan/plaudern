import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Post,
  Put,
} from '@nestjs/common';
import {
  panicDeleteRequestSchema,
  updateDeadMansSwitchRequestSchema,
  type AccountExport,
  type DeadMansSwitchDto,
  type PanicDeleteResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { DataSovereigntyService } from './data-sovereignty.service';

/**
 * Data-sovereignty controls for the signed-in user (JJ-42): export-everything,
 * panic-delete, and the dead-man's-switch scaffold. Every handler derives the
 * user id from the session (`@CurrentUser`), never the request body — these are
 * the most destructive endpoints in the app and must never be cross-user.
 */
@Controller({ path: 'account', version: '1' })
export class DataSovereigntyController {
  constructor(private readonly sovereignty: DataSovereigntyService) {}

  /**
   * Download the whole archive as one JSON bundle (items + extractions +
   * presigned assets + a combined Markdown rendering). Served as an attachment.
   */
  @Get('export')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="plaudern-export.json"')
  export(@CurrentUser() user: AuthenticatedUser): Promise<AccountExport> {
    return this.sovereignty.exportEverything(user.id);
  }

  /**
   * DANGER: irreversibly wipe the user's archive. Requires the exact
   * confirmation phrase in the body so it can't be triggered accidentally.
   */
  @Post('panic-delete')
  panicDelete(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<PanicDeleteResponse> {
    const parsed = panicDeleteRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        'panic-delete requires an explicit confirmation phrase',
      );
    }
    return this.sovereignty.panicDelete(user.id);
  }

  @Get('dead-mans-switch')
  getDeadMansSwitch(@CurrentUser() user: AuthenticatedUser): Promise<DeadMansSwitchDto> {
    return this.sovereignty.getDeadMansSwitch(user.id);
  }

  @Put('dead-mans-switch')
  updateDeadMansSwitch(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<DeadMansSwitchDto> {
    const parsed = updateDeadMansSwitchRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid request');
    }
    return this.sovereignty.updateDeadMansSwitch(user.id, parsed.data);
  }

  @Post('dead-mans-switch/check-in')
  checkIn(@CurrentUser() user: AuthenticatedUser): Promise<DeadMansSwitchDto> {
    return this.sovereignty.checkInDeadMansSwitch(user.id);
  }
}
