import { Navigate, Route, RouterProvider, createBrowserRouter, useLocation } from 'react-router';
import { Suspense, lazy } from 'react';
import { useAuth } from './auth/AuthProvider';
import { Spinner } from './components/ui';
import { AppShell } from './components/layout/AppShell';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { ProjectPage } from './features/project/ProjectPage';
import { ReleasePage } from './features/release/ReleasePage';
import { NewReleasePage } from './features/release/NewReleasePage';
import { AdminPage } from './features/admin/AdminPage';
import { InvitePage, LoginPage, SetupPage } from './features/auth/AuthPages';

// The file viewer carries Shiki + CodeMirror — keep them out of the main bundle.
const FilePage = lazy(() =>
  import('./features/file/FilePage').then((m) => ({ default: m.FilePage })),
);

function FullScreenLoad() {
  return (
    <div className="flex h-screen items-center justify-center text-ink-3">
      <Spinner className="h-5 w-5" />
    </div>
  );
}

function ShellGate() {
  const { loading, needsSetup, user } = useAuth();
  const location = useLocation();
  if (loading) return <FullScreenLoad />;
  if (needsSetup) return <Navigate to="/setup" replace />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <AppShell />;
}

function PublicOnly({ children }: { children: React.ReactNode }) {
  const { loading, user, needsSetup } = useAuth();
  const location = useLocation();
  if (loading) return <FullScreenLoad />;
  if (needsSetup && location.pathname !== '/setup') return <Navigate to="/setup" replace />;
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

const router = createBrowserRouter([
  {
    element: (
      <PublicOnly>
        <LoginPage />
      </PublicOnly>
    ),
    path: '/login',
  },
  {
    element: (
      <PublicOnly>
        <SetupPage />
      </PublicOnly>
    ),
    path: '/setup',
  },
  { path: '/invite/:code', element: <InvitePage /> },
  {
    element: <ShellGate />,
    children: [
      { path: '/', element: <DashboardPage /> },
      { path: '/p/:slug', element: <ProjectPage /> },
      { path: '/p/:slug/new-release', element: <NewReleasePage /> },
      { path: '/p/:slug/r/:version', element: <ReleasePage /> },
      {
        path: '/p/:slug/r/:version/file/*',
        element: (
          <Suspense
            fallback={
              <div className="flex h-screen items-center justify-center text-ink-3">
                <Spinner className="h-5 w-5" />
              </div>
            }
          >
            <FilePage />
          </Suspense>
        ),
      },
      { path: '/admin', element: <AdminPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
