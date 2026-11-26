import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ensureApi } from './lib/atlas';
import './styles.css';

// Outside Electron (plain browser dev) a mock API is installed so the UI is still explorable.
void ensureApi().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
