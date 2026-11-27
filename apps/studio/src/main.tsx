import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App.js';
import { applyWindowChrome } from './features/runtime/runtime-bridge.js';
import { startThemeSync } from './features/settings/theme.js';
import '@xterm/xterm/css/xterm.css';
import './app/app.css';

const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('Studio root element was not found');
}

applyWindowChrome(document.documentElement);
startThemeSync(document.documentElement);

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
