/** Human-readable scope for the header/home page. */
export function scopeLabel(user) {
  if (!user) return '';
  switch (user.role_key) {
    case 'ZONE_ADMIN':
      return user.zone_name ? `Zone ${user.zone_name}` : 'Zone (unassigned)';
    case 'WARD_SUPERVISOR':
      return user.ward_name ? `Ward ${user.ward_name}${user.zone_name ? `, ${user.zone_name}` : ''}` : 'Ward (unassigned)';
    case 'AGENCY_USER':
      return user.agency_name ? `Agency ${user.agency_name}` : 'Agency (unassigned)';
    default:
      return 'All zones';
  }
}

const dtf = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
export function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : dtf.format(d);
}
