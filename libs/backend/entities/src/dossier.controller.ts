import { Controller, Get, Param } from '@nestjs/common';
import type { EntityDossierDto } from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { DossierService } from './dossier.service';

/**
 * The person dossier (JJ-24): one aggregated read model for a single registry
 * entity — facts, commitments, questions, relations and recent mentions, each
 * cited to its source recording. Mounted under the same `entities` path as the
 * registry; kept in its own controller so the aggregation route stays clear of
 * the registry/correction CRUD (and out of the way of parallel edits there).
 */
@Controller({ path: 'entities', version: '1' })
export class DossierController {
  constructor(private readonly dossier: DossierService) {}

  @Get(':id/dossier')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<EntityDossierDto> {
    return this.dossier.build(user.id, id);
  }
}
