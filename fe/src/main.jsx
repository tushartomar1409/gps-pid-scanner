import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { ToastProvider } from './components/Toast.jsx';
import { routes, ROUTER_FUTURE } from './App.jsx';
import './index.css';

const router = createBrowserRouter(routes, { future: ROUTER_FUTURE });

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ToastProvider>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </ToastProvider>
  </StrictMode>,
);
