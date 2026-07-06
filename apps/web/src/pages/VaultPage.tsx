import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Card, CardBody, Chip, Spinner } from '@heroui/react';
import { Link } from 'react-router-dom';
import type { DocumentDto, DocumentType } from '@plaudern/contracts';
import { listVaultDocuments } from '../lib/api';
import { VaultIcon } from '../components/icons';

/** Display labels + ordering for document types (grouped sections). */
const TYPE_LABELS: Record<DocumentType, string> = {
  contract: 'Contracts',
  insurance: 'Insurance',
  warranty: 'Warranties',
  invoice: 'Invoices',
  receipt: 'Receipts',
  bank_statement: 'Bank statements',
  payslip: 'Payslips',
  id_document: 'ID documents',
  prescription: 'Prescriptions',
  letter: 'Letters',
  business_card: 'Business cards',
  other: 'Other documents',
};

/** Deadline-bearing types are listed first — those are the ones with reminders. */
const TYPE_ORDER: DocumentType[] = [
  'contract',
  'insurance',
  'warranty',
  'invoice',
  'receipt',
  'bank_statement',
  'payslip',
  'id_document',
  'prescription',
  'letter',
  'business_card',
  'other',
];

/**
 * The document vault (JJ-16): every scanned image / uploaded PDF the docmeta
 * pipeline understood, grouped by document type, with expiry and Kündigungsfrist
 * dates surfaced and a link back to the source item. Reached from the header
 * vault icon — no bottom-nav tab (the bar stays at 6). iOS-PWA-safe: plain
 * toggled divs and native buttons, no HeroUI overlay.
 */
export function VaultPage() {
  const [documents, setDocuments] = useState<DocumentDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<DocumentType | 'all'>('all');

  const load = useCallback(async () => {
    setDocuments(null);
    try {
      const res = await listVaultDocuments();
      setDocuments(res.documents);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Types actually present, in display order — drives the filter chips. */
  const presentTypes = useMemo(() => {
    if (!documents) return [] as DocumentType[];
    const seen = new Set(documents.map((d) => d.documentType));
    return TYPE_ORDER.filter((t) => seen.has(t));
  }, [documents]);

  /** Documents grouped by type (respecting the active filter), in display order. */
  const groups = useMemo(() => {
    if (!documents) return [] as { type: DocumentType; docs: DocumentDto[] }[];
    const byType = new Map<DocumentType, DocumentDto[]>();
    for (const doc of documents) {
      if (typeFilter !== 'all' && doc.documentType !== typeFilter) continue;
      const list = byType.get(doc.documentType) ?? [];
      list.push(doc);
      byType.set(doc.documentType, list);
    }
    return TYPE_ORDER.filter((t) => byType.has(t)).map((type) => ({
      type,
      docs: byType.get(type)!,
    }));
  }, [documents, typeFilter]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <VaultIcon className="h-6 w-6 text-primary" />
        <h2 className="text-xl font-bold">Document vault</h2>
      </div>
      <p className="text-sm text-default-500">
        Contracts, IDs, warranties and paper mail you scanned — organized by type, with
        expiry and Kündigungsfrist deadlines turned into reminders.
      </p>

      {presentTypes.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <FilterChip active={typeFilter === 'all'} onPress={() => setTypeFilter('all')}>
            All
          </FilterChip>
          {presentTypes.map((type) => (
            <FilterChip
              key={type}
              active={typeFilter === type}
              onPress={() => setTypeFilter(type)}
            >
              {TYPE_LABELS[type]}
            </FilterChip>
          ))}
        </div>
      )}

      {error && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>
      )}

      {documents === null && !error && (
        <div className="flex justify-center py-16">
          <Spinner label="Loading vault…" />
        </div>
      )}

      {documents !== null && documents.length === 0 && (
        <Card>
          <CardBody className="flex flex-col items-center gap-3 py-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-default-100">
              <VaultIcon className="h-6 w-6 text-default-500" />
            </div>
            <div>
              <p className="font-medium">Your vault is empty</p>
              <p className="mt-1 max-w-sm text-sm text-default-500">
                Scan a document or upload a PDF from the inbox (the scan button). Once OCR and
                document understanding run, contracts, invoices and IDs show up here.
              </p>
            </div>
          </CardBody>
        </Card>
      )}

      {groups.map((group) => (
        <section key={group.type} className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-default-600">
            {TYPE_LABELS[group.type]}{' '}
            <span className="text-default-400">({group.docs.length})</span>
          </h3>
          <div className="flex flex-col gap-2">
            {group.docs.map((doc) => (
              <DocumentCard key={doc.id} doc={doc} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function DocumentCard({ doc }: { doc: DocumentDto }) {
  return (
    <Card as={Link} to={`/items/${doc.inboxItemId}`} isPressable className="w-full">
      <CardBody className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium">{doc.title}</p>
            {doc.issuer && (
              <p className="truncate text-sm text-default-500">{doc.issuer}</p>
            )}
          </div>
          {doc.amount !== null && (
            <span className="shrink-0 text-sm font-medium">
              {formatAmount(doc.amount, doc.currency)}
            </span>
          )}
        </div>

        {doc.summary && <p className="text-sm text-default-500">{doc.summary}</p>}

        {(doc.expiryDate || doc.cancellationDate) && (
          <div className="flex flex-wrap gap-2">
            {doc.expiryDate && (
              <Chip size="sm" variant="flat" color="warning">
                Expires {formatDate(doc.expiryDate)}
              </Chip>
            )}
            {doc.cancellationDate && (
              <Chip size="sm" variant="flat" color="danger">
                Kündigungsfrist {formatDate(doc.cancellationDate)}
              </Chip>
            )}
          </div>
        )}

        {doc.contact && (doc.contact.email || doc.contact.phone) && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-default-500">
            {doc.contact.jobTitle && <span>{doc.contact.jobTitle}</span>}
            {doc.contact.email && <span>{doc.contact.email}</span>}
            {doc.contact.phone && <span>{doc.contact.phone}</span>}
          </div>
        )}

        {doc.iban && <p className="text-xs text-default-400">IBAN {doc.iban}</p>}

        <p className="text-xs text-default-400">{formatDate(doc.documentDate ?? doc.occurredAt)}</p>
      </CardBody>
    </Card>
  );
}

function FilterChip({
  active,
  onPress,
  children,
}: {
  active: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant={active ? 'solid' : 'flat'}
      color={active ? 'primary' : 'default'}
      onPress={onPress}
    >
      {children}
    </Button>
  );
}

/** Render a date value: an ISO date reads as a locale date, else the raw phrase. */
function formatDate(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatAmount(amount: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: currency ? 'currency' : 'decimal',
      currency: currency ?? undefined,
    }).format(amount);
  } catch {
    return `${amount}${currency ? ` ${currency}` : ''}`;
  }
}
