// Sidebar items. Only pages that actually exist are listed (flow.txt §27 rule 16).
// `permission: null` = visible to every authenticated user; `role` = only that role;
// `hideIf` = hidden when the user has that permission (Home is replaced by Dashboard).
export const NAV_SECTIONS = [
  {
    title: null,
    items: [{ to: '/', label: 'Home', permission: null, hideIf: 'dashboard:read', end: true }],
  },
  {
    title: 'Monitoring',
    items: [
      { to: '/', label: 'Dashboard', permission: 'dashboard:read', end: true },
      { to: '/live', label: 'Live Tracking', permission: 'gps:read' },
      { to: '/coverage', label: 'Coverage Map', permission: 'assignments:read' },
      { to: '/history', label: 'GPS History', permission: 'gps:read' },
    ],
  },
  {
    title: 'Reports',
    items: [
      { to: '/reports/daily-coverage', label: 'Daily PID Coverage', permission: 'reports:read' },
      { to: '/reports/vehicle-wise', label: 'Vehicle-wise', permission: 'reports:read' },
      { to: '/reports/agency-wise', label: 'Agency-wise', permission: 'reports:read' },
      { to: '/reports/ward-wise', label: 'Ward-wise', permission: 'reports:read' },
      { to: '/reports/missed-pids', label: 'Missed PIDs', permission: 'reports:read' },
      { to: '/reports/archive', label: 'Report Archive', permission: null, role: ['SUPER_ADMIN', 'DEPARTMENT_ADMIN'] },
    ],
  },
  {
    title: 'Operations',
    items: [
      { to: '/pids', label: 'PIDs', permission: 'pids:read', end: true },
      { to: '/pids/import', label: 'PID Import', permission: 'pids:write' },
      { to: '/routes', label: 'Routes', permission: 'routes:read' },
      { to: '/assignments', label: 'Assignments', permission: 'assignments:read' },
    ],
  },
  {
    title: 'Master Data',
    items: [
      { to: '/zones', label: 'Zones', permission: 'zones:read' },
      { to: '/wards', label: 'Wards', permission: 'wards:read' },
      { to: '/agencies', label: 'Agencies', permission: 'agencies:read' },
      { to: '/vehicles', label: 'Vehicles', permission: 'vehicles:read' },
    ],
  },
  {
    title: 'Administration',
    items: [
      { to: '/users', label: 'Users', permission: 'users:read' },
      { to: '/settings/detection', label: 'Detection Settings', permission: null, role: 'SUPER_ADMIN' },
      { to: '/settings/gps', label: 'GPS Integration', permission: 'gps:read' },
      { to: '/settings/activity-logs', label: 'Activity Logs', permission: null, role: 'SUPER_ADMIN' },
    ],
  },
];
