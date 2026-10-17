import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Spinner, Toasts } from './components/ui'

const Landing = lazy(() => import('./landing/Landing'))
const AppShell = lazy(() => import('./pages/AppShell'))
const Hub = lazy(() => import('./pages/Hub'))
const Workspace = lazy(() => import('./pages/Workspace'))

const Loading = () => <div className="grid h-full min-h-screen place-items-center bg-abyss"><Spinner size={28} /></div>

export default function App() {
  return (
    <>
      <ErrorBoundary>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/app" element={<AppShell />}>
              <Route index element={<Hub />} />
              <Route path="w/:id" element={<Workspace />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
      <Toasts />
    </>
  )
}
