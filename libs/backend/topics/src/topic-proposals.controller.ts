import { Controller, HttpCode, HttpStatus, Param, Post, Get } from '@nestjs/common';
import type { TopicDto, TopicProposalListResponse } from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { TopicProposalsService } from './topic-proposals.service';

/**
 * Taxonomy proposals from embedding clusters (JJ-64). Lives inside the topics
 * module and hangs off /topics/proposals; the UI renders these as a section of
 * the existing topics page (no new route/tab). `enabled` in the list response
 * lets the UI hide the section when the feature is unconfigured.
 */
@Controller({ path: 'topics/proposals', version: '1' })
export class TopicProposalsController {
  constructor(private readonly proposals: TopicProposalsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<TopicProposalListResponse> {
    return this.proposals.listProposals(user.id);
  }

  /**
   * Enqueue a fresh clustering + labeling pass and return immediately (202) with
   * the current list + run status (JJ-69). The heavy pass runs on the worker; the
   * UI polls GET /topics/proposals until `generation.status` settles. A double-
   * click coalesces onto the in-flight run rather than enqueuing a duplicate.
   */
  @Post('generate')
  @HttpCode(HttpStatus.ACCEPTED)
  generate(@CurrentUser() user: AuthenticatedUser): Promise<TopicProposalListResponse> {
    return this.proposals.generate(user.id);
  }

  /** One-tap accept: create the topic and reclassify the cluster's items. */
  @Post(':id/accept')
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<TopicDto> {
    return this.proposals.accept(user.id, id);
  }

  @Post(':id/dismiss')
  @HttpCode(HttpStatus.NO_CONTENT)
  async dismiss(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    await this.proposals.dismiss(user.id, id);
  }
}
