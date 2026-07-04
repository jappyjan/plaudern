import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Chip, Spinner } from '@heroui/react';
import type { TopicDto, TopicItemDto } from '@plaudern/contracts';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { deleteTopic, listTopicItems, listTopics, updateTopic } from '../lib/api';
import { TopicModal } from '../components/TopicModal';
import { ConfirmDeleteModal } from '../components/ConfirmDeleteModal';
import { ArchiveIcon, BackIcon, EditIcon, TrashIcon } from '../components/icons';
import { formatDateTime } from '../lib/format';

/** One topic: its details, edit/archive/delete actions and every item tagged with it. */
export function TopicDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [topic, setTopic] = useState<TopicDto | null>(null);
  const [items, setItems] = useState<TopicItemDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [all, itemsRes] = await Promise.all([listTopics(), listTopicItems(id)]);
      const found = all.topics.find((t) => t.id === id) ?? null;
      if (!found) {
        setError('Topic not found.');
        return;
      }
      setTopic(found);
      setItems(itemsRes.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>
      </div>
    );
  }
  if (!topic || !items || !id) {
    return (
      <div className="flex justify-center py-12">
        <Spinner label="Loading…" />
      </div>
    );
  }

  const toggleArchive = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateTopic(id, { archived: !topic.archived });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteTopic(id);
      navigate('/topics');
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : String(cause));
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <BackLink />

      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-lg font-semibold">{topic.name}</p>
                {topic.archived && (
                  <Chip size="sm" variant="flat">
                    archived
                  </Chip>
                )}
              </div>
              {topic.description && (
                <p className="text-sm text-default-500">{topic.description}</p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="flat"
              startContent={<EditIcon className="h-4 w-4" />}
              isDisabled={busy}
              onPress={() => setEditOpen(true)}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="flat"
              startContent={<ArchiveIcon className="h-4 w-4" />}
              isDisabled={busy}
              onPress={() => void toggleArchive()}
            >
              {topic.archived ? 'Unarchive' : 'Archive'}
            </Button>
            <Button
              size="sm"
              color="danger"
              variant="light"
              startContent={<TrashIcon className="h-4 w-4" />}
              isDisabled={busy}
              onPress={() => setConfirmOpen(true)}
            >
              Delete
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between pb-0">
          <h2 className="text-sm font-semibold">Items</h2>
          <Chip size="sm" variant="flat">
            {items.length}
          </Chip>
        </CardHeader>
        <CardBody className="gap-2">
          {items.length === 0 && (
            <p className="text-sm text-default-500">
              No items are classified under this topic yet.
            </p>
          )}
          {items.map((item) => (
            <Link
              key={item.inboxItemId}
              to={`/items/${item.inboxItemId}`}
              className="flex items-center justify-between gap-3 rounded-medium p-2 text-sm hover:bg-default-100"
            >
              <span className="min-w-0 truncate">{formatDateTime(item.occurredAt)}</span>
              <Chip size="sm" variant="flat" className="shrink-0">
                {(item.confidence * 100).toFixed(0)}%
              </Chip>
            </Link>
          ))}
        </CardBody>
      </Card>

      <TopicModal
        isOpen={editOpen}
        topic={topic}
        onClose={() => setEditOpen(false)}
        onSaved={() => void load()}
      />

      <ConfirmDeleteModal
        isOpen={confirmOpen}
        isDeleting={deleting}
        error={deleteError}
        title="Delete topic?"
        message={`This permanently deletes "${topic.name}" and removes it from the ${items.length} item${items.length === 1 ? '' : 's'} currently assigned to it. This cannot be undone.`}
        onConfirm={() => void confirmDelete()}
        onClose={() => {
          setConfirmOpen(false);
          setDeleteError(null);
        }}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Button
      as={Link}
      to="/topics"
      variant="light"
      size="sm"
      className="self-start"
      startContent={<BackIcon className="h-4 w-4" />}
    >
      Topics
    </Button>
  );
}
