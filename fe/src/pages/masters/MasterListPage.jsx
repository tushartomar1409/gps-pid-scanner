// Shared list/create/edit/deactivate screen for master resources.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DataTable } from '../../components/DataTable.jsx';
import { Button } from '../../components/Button.jsx';
import { Input } from '../../components/Input.jsx';
import { Select } from '../../components/Select.jsx';
import { Modal } from '../../components/Modal.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { useToast } from '../../components/Toast.jsx';
import { usePermission } from '../../auth/usePermission.js';
import { useListParams } from '../../hooks/useListParams.js';
import { usePaginatedQuery } from '../../hooks/usePaginatedQuery.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { useLookups } from '../../hooks/useLookups.js';
import { parseApiError } from '../../utils/apiErrors.js';

const PAGE_SIZE = 20;

/**
 * config: {
 *   title, description, singular, permission, api, searchPlaceholder,
 *   lookupTypes?: ['zones', ...],
 *   filters: [{ key, label, type: 'select'|'text', options?: (lookups, params) => [{value,label}] , dependsOn?: key }],
 *   columns: [{ key, header, render? }],
 *   Form: component({ formId, initial, isEdit, lookups, serverErrors, onSubmit }),
 *   conflictMessages?: { [constraint]: message }, conflictFallback?: string,
 *   // Optional extensions (Phase 2b):
 *   createPath?: string, editPath?: (row) => string,   // navigate to a full page instead of the modal
 *   extraRowActions?: (row, { refetch }) => node,       // extra buttons (write users only)
 *   extraKeys?: string[],                               // extra URL params kept in sync (e.g. 'view')
 *   renderToolbar?: ({ params, setParams, refetch }) => node,
 *   renderAlternateView?: ({ params, setParams, refetch }) => node | null, // replaces the table when non-null
 * }
 */
export function MasterListPage({ config }) {
  const { title, description, singular, permission, api, filters = [], lookupTypes = [], Form } = config;
  const can = usePermission();
  const canWrite = can(`${permission}:write`);
  const toast = useToast();
  const navigate = useNavigate();

  const filterKeys = filters.map((f) => f.key);
  const { params, setParams, setPage } = useListParams([...filterKeys, ...(config.extraKeys || [])]);
  const lookups = useLookups(lookupTypes.length ? lookupTypes : ['zones']);

  // Debounced search synced to the URL.
  const [searchInput, setSearchInput] = useState(params.search);
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  useEffect(() => {
    if (debouncedSearch !== params.search) setParams({ search: debouncedSearch });
  }, [debouncedSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  const queryParams = useMemo(() => ({ ...params, limit: PAGE_SIZE }), [params]);
  const { rows, pagination, loading, error, refetch } = usePaginatedQuery(api.list, queryParams);

  // Create / edit modal
  const [editing, setEditing] = useState(null); // null = closed, {} = create, row = edit
  const [submitting, setSubmitting] = useState(false);
  const [serverErrors, setServerErrors] = useState({});
  const isEdit = Boolean(editing?.id);
  const formId = `${permission}-form`;

  const openCreate = () => {
    if (config.createPath) return navigate(config.createPath);
    setServerErrors({});
    setEditing({});
  };
  const openEdit = (row) => {
    if (config.editPath) return navigate(config.editPath(row));
    setServerErrors({});
    setEditing(row);
  };
  const closeModal = () => !submitting && setEditing(null);

  const handleSubmit = async (payload) => {
    setSubmitting(true);
    setServerErrors({});
    try {
      if (isEdit) await api.update(editing.id, payload);
      else await api.create(payload);
      toast.success(`${singular} ${isEdit ? 'updated' : 'created'} successfully`);
      setEditing(null);
      refetch();
    } catch (err) {
      const e = parseApiError(err);
      const hasFieldErrors = Object.keys(e.fieldErrors).length > 0;
      if (hasFieldErrors) setServerErrors(e.fieldErrors);
      if (e.status === 409) toast.error(config.conflictMessages?.[e.constraint] || config.conflictFallback || e.message);
      else toast.error(hasFieldErrors ? `${e.message}. Please fix the highlighted fields.` : e.message);
    } finally {
      setSubmitting(false);
    }
  };

  // Deactivate
  const [confirmRow, setConfirmRow] = useState(null);
  const [deactivating, setDeactivating] = useState(false);
  const handleDeactivate = async () => {
    setDeactivating(true);
    try {
      await api.deactivate(confirmRow.id);
      toast.success(`${singular} deactivated`);
      setConfirmRow(null);
      refetch();
    } catch (err) {
      toast.error(parseApiError(err).message);
    } finally {
      setDeactivating(false);
    }
  };

  const columns = [
    ...config.columns,
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    ...(canWrite
      ? [
          {
            key: '_actions',
            header: <span className="sr-only">Actions</span>,
            className: 'text-right',
            render: (r) => (
              <div className="flex justify-end gap-1">
                {config.extraRowActions?.(r, { refetch })}
                <Button variant="ghost" size="sm" onClick={() => openEdit(r)} aria-label={`Edit ${r[config.labelKey] ?? r.id}`}>
                  Edit
                </Button>
                {r.status !== 'INACTIVE' && (
                  <Button variant="ghost" size="sm" className="text-red-700" onClick={() => setConfirmRow(r)}>
                    Deactivate
                  </Button>
                )}
              </div>
            ),
          },
        ]
      : []),
  ];

  const hasActiveFilters = Boolean(params.search) || filterKeys.some((k) => params[k]);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
          {description && <p className="text-sm text-slate-500">{description}</p>}
        </div>
        {canWrite && <Button onClick={openCreate}>Add {singular.toLowerCase()}</Button>}
      </div>

      <div className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm sm:grid-cols-2 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <Input
            label="Search"
            type="search"
            placeholder={config.searchPlaceholder || 'Search…'}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        {filters.map((f) =>
          f.type === 'text' ? (
            <Input key={f.key} label={f.label} value={params[f.key]} onChange={(e) => setParams({ [f.key]: e.target.value })} />
          ) : (
            <Select
              key={f.key}
              label={f.label}
              placeholder="All"
              value={params[f.key]}
              options={f.options(lookups.data, params)}
              onChange={(e) => {
                const patch = { [f.key]: e.target.value };
                // Clear dependent filters (e.g. ward when zone changes).
                for (const dep of filters.filter((d) => d.dependsOn === f.key)) patch[dep.key] = '';
                setParams(patch);
              }}
            />
          ),
        )}
      </div>

      {config.renderToolbar?.({ params, setParams, refetch })}

      {config.renderAlternateView?.({ params, setParams, refetch }) ?? (
        <DataTable
          columns={columns}
          rows={rows}
          loading={loading}
          error={error}
          onRetry={refetch}
          pagination={pagination}
          onPageChange={setPage}
          emptyTitle={hasActiveFilters ? 'No matching records' : `No ${title.toLowerCase()} yet`}
          emptyMessage={
            hasActiveFilters ? 'Try changing the search or filters.' : canWrite ? `Use “Add ${singular.toLowerCase()}” to create the first one.` : undefined
          }
        />
      )}

      <Modal
        open={editing !== null}
        title={isEdit ? `Edit ${singular.toLowerCase()}` : `Add ${singular.toLowerCase()}`}
        onClose={closeModal}
        footer={
          <>
            <Button variant="secondary" onClick={closeModal} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" form={formId} loading={submitting}>
              {isEdit ? 'Save changes' : 'Create'}
            </Button>
          </>
        }
      >
        {editing !== null && (
          <Form formId={formId} initial={editing} isEdit={isEdit} lookups={lookups.data} serverErrors={serverErrors} onSubmit={handleSubmit} />
        )}
      </Modal>

      <ConfirmDialog
        open={confirmRow !== null}
        title={`Deactivate ${singular.toLowerCase()}?`}
        message={`“${confirmRow?.[config.labelKey] ?? ''}” will be marked inactive. Records are never deleted and it can be re-activated by editing its status.`}
        confirmLabel="Deactivate"
        busy={deactivating}
        onConfirm={handleDeactivate}
        onCancel={() => setConfirmRow(null)}
      />
    </div>
  );
}

export const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
];
