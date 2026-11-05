import { MasterListPage, STATUS_OPTIONS } from '../masters/MasterListPage.jsx';
import { toOptions } from '../../hooks/useLookups.js';
import { routesApi } from '../../api/resources.js';

const config = {
  title: 'Routes',
  description: 'Collection routes and their assigned PIDs.',
  singular: 'Route',
  permission: 'routes',
  labelKey: 'route_code',
  api: routesApi,
  lookupTypes: ['zones', 'wards', 'agencies'],
  searchPlaceholder: 'Route code or name',
  createPath: '/routes/new',
  editPath: (r) => `/routes/${r.id}`,
  filters: [
    { key: 'zone_id', label: 'Zone', type: 'select', options: (l) => toOptions(l.zones) },
    { key: 'ward_id', label: 'Ward', type: 'select', dependsOn: 'zone_id', options: (l, p) => toOptions((l.wards || []).filter((w) => !p.zone_id || String(w.zone_id) === p.zone_id)) },
    { key: 'agency_id', label: 'Agency', type: 'select', options: (l) => toOptions(l.agencies) },
    { key: 'status', label: 'Status', type: 'select', options: () => STATUS_OPTIONS },
  ],
  columns: [
    { key: 'route_code', header: 'Code', render: (r) => <span className="font-mono text-xs font-semibold">{r.route_code}</span> },
    { key: 'route_name', header: 'Name' },
    { key: 'zone_name', header: 'Zone' },
    { key: 'ward_name', header: 'Ward' },
    { key: 'agency_name', header: 'Agency' },
    { key: 'default_vehicle_number', header: 'Default vehicle' },
    { key: 'pid_count', header: 'PIDs' },
  ],
  // Create/edit happen on the full-page builder (createPath/editPath); no modal form.
  Form: () => null,
};

export default function RoutesPage() {
  return <MasterListPage config={config} />;
}
