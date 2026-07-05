import { BadRequestException, Controller, Get, Param, Post } from '@nestjs/common';
import type {
  TopicDocumentResponse,
  TopicDocumentVersionDetailDto,
  TopicDocumentVersionListResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { TopicDocumentService } from './topic-document.service';

/**
 * A topic's living document (JJ-12): its current cited body, its version
 * history, and a manual regenerate action. Hangs off /topics/:id/document — no
 * new nav tab; the topics UI links to it from the topic detail page.
 */
@Controller({ path: 'topics', version: '1' })
export class TopicDocumentController {
  constructor(private readonly documents: TopicDocumentService) {}

  @Get(':id/document')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<TopicDocumentResponse> {
    return this.documents.getDocument(user.id, id);
  }

  @Get(':id/document/versions')
  versions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<TopicDocumentVersionListResponse> {
    return this.documents.listVersions(user.id, id);
  }

  @Get(':id/document/versions/:version')
  version(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('version') version: string,
  ): Promise<TopicDocumentVersionDetailDto> {
    const parsed = Number(version);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException('invalid version');
    }
    return this.documents.getVersion(user.id, id, parsed);
  }

  /** Manually (re)generate the document, then return the refreshed read model. */
  @Post(':id/document/regenerate')
  async regenerate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<TopicDocumentResponse> {
    await this.documents.regenerate(user.id, id);
    return this.documents.getDocument(user.id, id);
  }
}
