import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';

import { Shell } from './components/Layout';
import { ToastProvider } from './components/ui';
import { AlertsPage } from './pages/Alerts';
import { AnalyticsPage } from './pages/Analytics';
import { CalendarPage } from './pages/Calendar';
import { ClientPage } from './pages/Client';
import { ClientsPage } from './pages/Clients';
import { Composer } from './pages/Composer';
import { ConnectPick } from './pages/ConnectPick';
import { Dashboard } from './pages/Dashboard';
import { ImportPage } from './pages/Import';
import { Login } from './pages/Login';
import { Portal } from './pages/Portal';
import { PostDetail } from './pages/PostDetail';
import { PostsPage } from './pages/Posts';
import { PublicReport, ReportPage } from './pages/Report';
import { SettingsPage } from './pages/Settings';

// Apply the saved theme before first paint.
try {
  document.documentElement.dataset.theme = localStorage.getItem('sc_theme') ?? 'light';
} catch {
  /* ignore */
}

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  { path: '/c/:token', element: <Portal /> },
  { path: '/r/:token', element: <PublicReport /> },
  {
    element: <Shell />,
    children: [
      { path: '/', element: <Dashboard /> },
      { path: '/calendar', element: <CalendarPage /> },
      { path: '/analytics', element: <AnalyticsPage /> },
      { path: '/posts', element: <PostsPage /> },
      { path: '/posts/new', element: <Composer /> },
      { path: '/posts/import', element: <ImportPage /> },
      { path: '/posts/:id', element: <PostDetail /> },
      { path: '/posts/:id/edit', element: <Composer /> },
      { path: '/clients', element: <ClientsPage /> },
      { path: '/clients/:id', element: <ClientPage /> },
      { path: '/clients/:id/report', element: <ReportPage /> },
      { path: '/connect/:id', element: <ConnectPick /> },
      { path: '/alerts', element: <AlertsPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '*', element: <div className="empty"><h3>Page not found</h3></div> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </StrictMode>,
);
