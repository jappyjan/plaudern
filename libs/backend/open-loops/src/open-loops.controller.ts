import { BadRequestException, Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import {
  openLoopKindSchema,
  openLoopListQuerySchema,
  updateOpenLoopStateRequestSchema,
  type OpenLoopDto,
  type OpenLoopListResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { OpenLoopsService } from './open-loops.service';

/**
 * The unified open-loop ledger (JJ-29): the ranked list of unresolved threads
 * plus a state mutation that routes to the owning source. No global ZodError
 * filter exists, so queries/params/bodies are validated with `.safeParse` and
 * surfaced as 400s (mirrors the tasks/commitments controllers).
 */
@Controller({ path: 'open-loops', version: '1' })
export class OpenLoopsController {
  constructor(private readonly openLoops: OpenLoopsService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: unknown,
  ): Promise<OpenLoopListResponse> {
    const parsed = openLoopListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid query');
    }
    return { openLoops: await this.openLoops.list(user.id, parsed.data) };
  }

  @Patch(':kind/:id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<OpenLoopDto> {
    const parsedKind = openLoopKindSchema.safeParse(kind);
    if (!parsedKind.success) {
      throw new BadRequestException(`unknown open-loop kind: ${kind}`);
    }
    const parsed = updateOpenLoopStateRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid state');
    }
    return this.openLoops.updateState(user.id, parsedKind.data, id, parsed.data.state);
  }
}
