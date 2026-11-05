import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
// RouterProvider from react-router/dom: the DOM build (uses ReactDOM.flushSync for navigation updates).
import { RouterProvider } from 'react-router/dom';
import { ToastProvider } from './components/Toast.jsx';
import { routes } from './App.jsx';
import './index.css';

// React Router v7: the former v7_* future flags are the default behaviour now.
const router = createBrowserRouter(routes);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </StrictMode>,
);
