import { NavLink } from 'react-router-dom';
import { hasPermission } from '../auth/usePermission.js';
import { NAV_SECTIONS } from './navConfig.js';

/** item visible? permission, optional role, optional hideIf (hidden when the user HAS that permission). */
export function itemVisible(user, i) {
  if (!hasPermission(user, i.permission)) return false;
  if (i.role && ![].concat(i.role).includes(user?.role_key)) return false;
  if (i.hideIf && hasPermission(user, i.hideIf)) return false;
  return true;
}

/** Filters NAV_SECTIONS by the user's permissions; empty sections are dropped. */
export function visibleSections(user, sections = NAV_SECTIONS) {
  return sections
    .map((s) => ({ ...s, items: s.items.filter((i) => itemVisible(user, i)) }))
    .filter((s) => s.items.length > 0);
}

export function Sidebar({ user, onNavigate }) {
  const sections = visibleSections(user);
  return (
    <nav aria-label="Main navigation" className="flex flex-col gap-5 px-3 py-4">
      {sections.map((section) => (
        <div key={section.title || 'root'}>
          {section.title && <p className="px-3 pb-1.5 text-xs font-semibold uppercase tracking-wider text-emerald-200/70">{section.title}</p>}
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    `block rounded-md px-3 py-2 text-sm font-medium transition ${
                      isActive ? 'bg-emerald-800 text-white' : 'text-emerald-50/90 hover:bg-emerald-800/60 hover:text-white'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
