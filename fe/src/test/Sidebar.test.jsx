import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../layouts/Sidebar.jsx';

const renderSidebar = (user) =>
  render(
    <MemoryRouter>
      <Sidebar user={user} />
    </MemoryRouter>,
  );

describe('Sidebar', () => {
  it('hides items the user has no permission for', () => {
    renderSidebar({ permissions: ['zones:read', 'vehicles:read'] });
    const links = screen.getAllByRole('link').map((a) => a.textContent);
    expect(links).toEqual(['Home', 'Zones', 'Vehicles']);
    expect(screen.queryByText('Users')).not.toBeInTheDocument();
    expect(screen.queryByText('Administration')).not.toBeInTheDocument(); // empty section dropped
  });

  it('shows everything for the * permission', () => {
    renderSidebar({ permissions: ['*'] });
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Home', 'PIDs', 'PID Import', 'Routes', 'Assignments', 'Zones', 'Wards', 'Agencies', 'Vehicles', 'Users',
    ]);
  });

  it('shows the Operations section for read-only roles without the write-only Import item', () => {
    renderSidebar({ permissions: ['pids:read', 'routes:read', 'assignments:read'] });
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['Home', 'PIDs', 'Routes', 'Assignments']);
    expect(screen.getByText('Operations')).toBeInTheDocument();
  });

  it('shows only Home for a user without permissions', () => {
    renderSidebar({ permissions: [] });
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['Home']);
  });
});
