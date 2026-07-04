import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  searchRequestSchema,
  type SearchResponse,
  type SimilarResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { SearchService } from './search.service';

/**
 * Hybrid search over the whole memory (JJ-38). POST (not GET) because the
 * request carries a nested structured-filter object; the body is validated with
 * `.safeParse` and surfaced as a 400 (no global ZodError filter exists).
 */
@Controller({ path: 'search', version: '1' })
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Post()
  run(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown): Promise<SearchResponse> {
    const parsed = searchRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid search request');
    }
    return this.search.search(user.id, parsed.data);
  }
}

/**
 * "More like this" for one item, mounted on /inbox/:id for symmetry with the
 * summary/transcript/topics routes; lives here so the inbox lib stays free of a
 * search dependency (mirrors ItemTopicsController).
 */
@Controller({ path: 'inbox', version: '1' })
export class ItemSimilarController {
  constructor(private readonly search: SearchService) {}

  @Get(':id/similar')
  similar(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ): Promise<SimilarResponse> {
    return this.search.similar(user.id, id, Math.min(Math.max(limit, 1), 50));
  }
}
