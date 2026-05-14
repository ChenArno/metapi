import { describe, expect, it } from 'vitest';
import { act, create } from 'react-test-renderer';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';

function LocationProbe() {
  const location = useLocation();
  return <div>{`${location.pathname}${location.search}`}</div>;
}

describe('Accounts tokens compatibility redirect', () => {
  it('redirects the legacy accounts tokens segment to /tokens', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts?segment=tokens']}>
            <ToastProvider>
              <Routes>
                <Route path="/accounts" element={<Accounts />} />
                <Route path="/tokens" element={<LocationProbe />} />
              </Routes>
            </ToastProvider>
          </MemoryRouter>,
        );
      });

      expect(JSON.stringify(root.toJSON())).toContain('/tokens');
    } finally {
      root?.unmount();
    }
  });
});
