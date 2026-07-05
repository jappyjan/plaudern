import { Controller, Get, Param, Post } from '@nestjs/common';
import type { ItemOcrResponse } from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { OcrService } from './ocr.service';

/**
 * An item's OCR read model + manual re-extraction. Mounted on /inbox/:id for
 * symmetry with the transcript/summary/reminders routes; lives in this module
 * so the inbox lib stays free of any OCR dependency.
 */
@Controller({ path: 'inbox', version: '1' })
export class InboxOcrController {
  constructor(private readonly ocr: OcrService) {}

  @Get(':id/ocr')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ItemOcrResponse> {
    return this.ocr.getItemOcr(user.id, id);
  }

  @Post(':id/ocr/retry')
  async retry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ItemOcrResponse> {
    await this.ocr.retry(user.id, id);
    return this.ocr.getItemOcr(user.id, id);
  }
}
