import { Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from './auth/ProtectedRoute.jsx';
import { AppLayout } from './layouts/AppLayout.jsx';
import LoginPage from './pages/LoginPage.jsx';
import HomePage from './pages/HomePage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';
import ZonesPage from './pages/masters/ZonesPage.jsx';
import WardsPage from './pages/masters/WardsPage.jsx';
import AgenciesPage from './pages/masters/AgenciesPage.jsx';
import VehiclesPage from './pages/masters/VehiclesPage.jsx';
import UsersPage from './pages/masters/UsersPage.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route index element={<HomePage />} />
          <Route path="zones" element={<ProtectedRoute permission="zones:read"><ZonesPage /></ProtectedRoute>} />
          <Route path="wards" element={<ProtectedRoute permission="wards:read"><WardsPage /></ProtectedRoute>} />
          <Route path="agencies" element={<ProtectedRoute permission="agencies:read"><AgenciesPage /></ProtectedRoute>} />
          <Route path="vehicles" element={<ProtectedRoute permission="vehicles:read"><VehiclesPage /></ProtectedRoute>} />
          <Route path="users" element={<ProtectedRoute permission="users:read"><UsersPage /></ProtectedRoute>} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
