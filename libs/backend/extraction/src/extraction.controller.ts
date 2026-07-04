import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  extractionBackfillRequestSchema,
  type ExtractionGraphResponse,
  type ExtractionRunDto,
  type ExtractionRunListResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { ExtractorGraph } from './extractor-graph';
import { ExtractionRunsService } from './extraction-runs.service';

/**
 * Introspection of the declarative extractor DAG plus backfill runs
 * ("re-run kind@version over past items").
 */
@Controller({ path: 'extractions', version: '1' })
export class ExtractionController {
  constructor(
    private readonly graph: ExtractorGraph,
    private readonly runs: ExtractionRunsService,
  ) {}

  @Get('graph')
  getGraph(): ExtractionGraphResponse {
    return { extractors: this.graph.toDto() };
  }

  @Post('backfills')
  startBackfill(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<ExtractionRunDto> {
    // No global ZodError filter exists, so a raw .parse() would surface as 500.
    const parsed = extractionBackfillRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid backfill request');
    }
    return this.runs.startBackfill(user.id, parsed.data);
  }

  @Get('backfills')
  async listBackfills(@CurrentUser() user: AuthenticatedUser): Promise<ExtractionRunListResponse> {
    return { runs: await this.runs.listRuns(user.id) };
  }

  @Get('backfills/:id')
  getBackfill(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ExtractionRunDto> {
    return this.runs.getRun(user.id, id);
  }
}
