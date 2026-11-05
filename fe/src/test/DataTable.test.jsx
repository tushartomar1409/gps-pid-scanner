import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataTable } from '../components/DataTable.jsx';

const columns = [
  { key: 'name', header: 'Name' },
  { key: 'code', header: 'Code', render: (r) => <b>{r.code.toLowerCase()}</b> },
];
const rows = [
  { id: 1, name: 'NIT', code: 'N1' },
  { id: 2, name: 'Old Faridabad', code: 'OF' },
];

describe('DataTable + Pagination', () => {
  it('renders rows, custom cells and page info from the API pagination', async () => {
    const onPageChange = vi.fn();
    render(<DataTable columns={columns} rows={rows} pagination={{ page: 2, limit: 20, total: 45, total_pages: 3 }} onPageChange={onPageChange} />);

    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByText('Old Faridabad')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toHaveTextContent('Showing 21–40 of 45');
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenCalledWith(3);
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('disables Previous on the first page and Next on the last page', () => {
    const { rerender } = render(<DataTable columns={columns} rows={rows} pagination={{ page: 1, limit: 20, total: 2, total_pages: 1 }} onPageChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    rerender(<DataTable columns={columns} rows={rows} pagination={{ page: 3, limit: 20, total: 45, total_pages: 3 }} onPageChange={() => {}} />);
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toHaveTextContent('Showing 41–45 of 45');
  });

  it('shows empty, loading and error states', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<DataTable columns={columns} rows={[]} emptyTitle="No zones yet" />);
    expect(screen.getByText('No zones yet')).toBeInTheDocument();

    rerender(<DataTable columns={columns} rows={[]} loading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');

    rerender(<DataTable columns={columns} rows={[]} error="Server down" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Server down');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });
});
