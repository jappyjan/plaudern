import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import {
  createCorrectionNoteRequestSchema,
  type CorrectionNoteListResponse,
  type CorrectionNoteMutationResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { CorrectionNotesService } from './correction-notes.service';

/**
 * User correction notes on an inbox item. Mounted on /inbox/:id like the
 * summary routes (and lives in this module for the same reason: the inbox lib
 * must stay free of summarization dependencies). Adding or deleting a note
 * best-effort queues a fresh summary generation so the correction takes
 * effect without a manual retry.
 */
@Controller({ path: 'inbox', version: '1' })
export class CorrectionNotesController {
  constructor(private readonly notes: CorrectionNotesService) {}

  @Get(':id/notes')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<CorrectionNoteListResponse> {
    return { notes: await this.notes.list(user.id, id) };
  }

  @Post(':id/notes')
  async add(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CorrectionNoteMutationResponse> {
    // No global ZodError filter exists, so a raw .parse() would surface as 500.
    const parsed = createCorrectionNoteRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid note');
    }
    return this.notes.add(user.id, id, parsed.data.body);
  }

  @Delete(':id/notes/:noteId')
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('noteId') noteId: string,
  ): Promise<CorrectionNoteMutationResponse> {
    return this.notes.remove(user.id, id, noteId);
  }
}
