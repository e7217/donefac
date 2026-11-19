import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Workspace from '../src/Workspace';
import '../app/globals.css';

const root = document.getElementById('root');
if (!root) throw new Error('Teamspace root element is missing.');
const pilotAccess = document.querySelector<HTMLMetaElement>('meta[name="teamspace-pilot-access"]')?.content === 'enabled';

createRoot(root).render(
  <StrictMode>
    <Workspace environmentLabel="파일럿 환경" pilotAccess={pilotAccess} />
  </StrictMode>,
);
