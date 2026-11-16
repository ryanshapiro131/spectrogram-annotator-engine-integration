import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth, useAuth } from './auth/AuthContext';
import AppShell from './shell/AppShell';
import LoginPage from './pages/LoginPage';
import ProjectsPage, { ProjectsUnavailable } from './pages/ProjectsPage';
import ProjectPage from './pages/ProjectPage';
import ProjectAudioPage from './pages/ProjectAudioPage';
import StandaloneAudioPage from './pages/StandaloneAudioPage';
import ComingSoonPage from './pages/ComingSoonPage';

// Project pages need the server's accounts/database; without them, explain
// instead of failing.
function ProjectsOnly({ children }) {
  const { authEnabled } = useAuth();
  return authEnabled ? children : <ProjectsUnavailable />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth><AppShell /></RequireAuth>}>
            <Route index element={<ProjectsPage />} />
            <Route path="projects/:projectId" element={<ProjectsOnly><ProjectPage /></ProjectsOnly>} />
            <Route path="projects/:projectId/audio/:mediaId" element={<ProjectsOnly><ProjectAudioPage /></ProjectsOnly>} />
            {/* Photo / video annotators: not built yet. */}
            <Route path="projects/:projectId/photo/:mediaId" element={<ComingSoonPage type="image" />} />
            <Route path="projects/:projectId/video/:mediaId" element={<ComingSoonPage type="video" />} />
            <Route path="audio" element={<StandaloneAudioPage />} />
            <Route path="photo" element={<ComingSoonPage type="image" />} />
            <Route path="video" element={<ComingSoonPage type="video" />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
