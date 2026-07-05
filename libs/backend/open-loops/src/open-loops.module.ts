import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TaskCitationEntity } from '@plaudern/persistence';
import { TasksModule } from '@plaudern/tasks';
import { CommitmentsModule } from '@plaudern/commitments';
import { QuestionsModule } from '@plaudern/questions';
import { OPEN_LOOP_SOURCES, type OpenLoopSource } from './open-loop-source';
import { TaskOpenLoopSource } from './task-open-loop.source';
import { CommitmentOpenLoopSource } from './commitment-open-loop.source';
import { QuestionOpenLoopSource } from './question-open-loop.source';
import { OpenLoopsService } from './open-loops.service';
import { OpenLoopsController } from './open-loops.controller';

/**
 * The unified open-loop ledger (JJ-29). Read-side only — it owns no table and
 * runs no migration; it composes the task (JJ-35), commitment (JJ-36) and open
 * question (JJ-34) read models into one ranked list and delegates every
 * mutation back to them.
 *
 * Sources are collected into the `OPEN_LOOP_SOURCES` multi-provider array — the
 * documented extension point: a future kind binds here (add its provider + one
 * array entry) with no change to the service, controller, or contract.
 */
@Module({
  imports: [
    TasksModule,
    CommitmentsModule,
    QuestionsModule,
    // TaskOpenLoopSource resolves each task's most-recent source recording.
    TypeOrmModule.forFeature([TaskCitationEntity]),
  ],
  providers: [
    TaskOpenLoopSource,
    CommitmentOpenLoopSource,
    QuestionOpenLoopSource,
    {
      provide: OPEN_LOOP_SOURCES,
      inject: [TaskOpenLoopSource, CommitmentOpenLoopSource, QuestionOpenLoopSource],
      useFactory: (
        tasks: TaskOpenLoopSource,
        commitments: CommitmentOpenLoopSource,
        questions: QuestionOpenLoopSource,
      ): OpenLoopSource[] => [tasks, commitments, questions],
    },
    OpenLoopsService,
  ],
  controllers: [OpenLoopsController],
  exports: [OpenLoopsService],
})
export class OpenLoopsModule {}
