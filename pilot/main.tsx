import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Workspace from '../src/Workspace';
import '../app/globals.css';

const root = document.getElementById('root');
if (!root) throw new Error('Teamspace root element is missing.');

createRoot(root).render(
  <StrictMode>
    <Workspace environmentLabel="파일럿 환경" />
  </StrictMode>,
);
