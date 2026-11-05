// Sidebar items. Only pages that actually exist are listed (flow.txt §27 rule 16).
// `permission: null` = visible to every authenticated user.
export const NAV_SECTIONS = [
  {
    title: null,
    items: [{ to: '/', label: 'Home', permission: null, end: true }],
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
    items: [{ to: '/users', label: 'Users', permission: 'users:read' }],
  },
];
