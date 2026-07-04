import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardBody, Chip, Spinner } from '@heroui/react';
import type { TopicDto } from '@plaudern/contracts';
import { Link } from 'react-router-dom';
import { listTopics } from '../lib/api';
import { TopicModal } from '../components/TopicModal';
import { TagIcon } from '../components/icons';

/**
 * The editable topic/project taxonomy. New and reprocessed inbox items are
 * classified against these entries automatically; archiving keeps history but
 * hides a topic from future classification.
 */
export function TopicsPage() {
  const [topics, setTopics] = useState<TopicDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await listTopics();
      setTopics(res.topics);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>;
  }
  if (!topics) {
    return (
      <div className="flex justify-center py-12">
        <Spinner label="Loading…" />
      </div>
    );
  }

  const active = topics.filter((t) => !t.archived);
  const archived = topics.filter((t) => t.archived);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Topics</h2>
        <Button size="sm" color="primary" onPress={() => setModalOpen(true)}>
          New topic
        </Button>
      </div>

      {topics.length === 0 ? (
        <Card>
          <CardBody className="flex flex-col items-center gap-3 py-10 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-default-100 text-default-500">
              <TagIcon className="h-6 w-6" />
            </span>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">No topics yet</p>
              <p className="max-w-sm text-sm text-default-500">
                Create your first topic or project. New and reprocessed items get classified
                against your topics automatically.
              </p>
            </div>
            <Button size="sm" color="primary" onPress={() => setModalOpen(true)}>
              Create your first topic
            </Button>
          </CardBody>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-default-500">
            New and reprocessed items are classified against these topics automatically.
          </p>
          {active.map((topic) => (
            <TopicCard key={topic.id} topic={topic} />
          ))}
          {active.length === 0 && (
            <p className="text-sm text-default-500">
              All topics are archived. Create a new one or unarchive an existing topic.
            </p>
          )}
        </div>
      )}

      {archived.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Archived</h2>
            <Chip size="sm" variant="flat">
              {archived.length}
            </Chip>
          </div>
          <p className="text-sm text-default-500">
            Hidden from future classification; past assignments are kept.
          </p>
          {archived.map((topic) => (
            <TopicCard key={topic.id} topic={topic} archived />
          ))}
        </div>
      )}

      <TopicModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={() => void load()}
      />
    </div>
  );
}

function TopicCard({ topic, archived }: { topic: TopicDto; archived?: boolean }) {
  return (
    <Card as={Link} to={`/topics/${topic.id}`} isPressable className={archived ? 'opacity-70' : ''}>
      <CardBody className="flex flex-row items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{topic.name}</p>
          {topic.description && (
            <p className="truncate text-xs text-default-500">{topic.description}</p>
          )}
        </div>
        {archived && (
          <Chip size="sm" variant="flat" className="shrink-0">
            archived
          </Chip>
        )}
      </CardBody>
    </Card>
  );
}
