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

  it('shows everything for the * permission; SUPER_ADMIN also gets the role-only admin pages', () => {
    renderSidebar({ permissions: ['*'], role_key: 'SUPER_ADMIN' });
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Dashboard', 'Live Tracking', 'Coverage Map', 'GPS History',
      'Daily PID Coverage', 'Vehicle-wise', 'Agency-wise', 'Ward-wise', 'Missed PIDs', 'Report Archive',
      'PIDs', 'PID Import', 'Routes', 'Assignments', 'Zones', 'Wards', 'Agencies', 'Vehicles',
      'Users', 'Detection Settings', 'GPS Integration', 'Activity Logs',
    ]);
    expect(screen.queryByText('Home')).not.toBeInTheDocument(); // replaced by Dashboard
  });

  it('role-only items stay hidden for other roles even with every permission', () => {
    renderSidebar({ permissions: ['*'], role_key: 'DEPARTMENT_ADMIN' });
    const links = screen.getAllByRole('link').map((a) => a.textContent);
    expect(links).toContain('GPS Integration');
    expect(links).not.toContain('Detection Settings');
    expect(links).not.toContain('Activity Logs');
    expect(links).toContain('Report Archive'); // archive: SUPER_ADMIN or DEPARTMENT_ADMIN
  });

  it('monitoring section for a dashboard + GPS reader (agency-style permissions)', () => {
    renderSidebar({ permissions: ['dashboard:read', 'gps:read', 'assignments:read', 'reports:read'], role_key: 'AGENCY_USER' });
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Dashboard', 'Live Tracking', 'Coverage Map', 'GPS History',
      'Daily PID Coverage', 'Vehicle-wise', 'Agency-wise', 'Ward-wise', 'Missed PIDs', // no archive: unscoped files
      'Assignments', 'GPS Integration',
    ]);
    expect(screen.getByText('Monitoring')).toBeInTheDocument();
  });

  it('shows the Operations section for read-only roles without the write-only Import item', () => {
    renderSidebar({ permissions: ['pids:read', 'routes:read', 'assignments:read'] });
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['Home', 'Coverage Map', 'PIDs', 'Routes', 'Assignments']);
    expect(screen.getByText('Operations')).toBeInTheDocument();
  });

  it('shows only Home for a user without permissions', () => {
    renderSidebar({ permissions: [] });
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['Home']);
  });
});
