import { describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Tokens from './Tokens.js';
import { installAccountsSnapshotCompat } from './testApiCompat.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccountTokens: vi.fn().mockResolvedValue([]),
    getAccounts: vi.fn().mockResolvedValue([]),
    getAccountsSnapshot: vi.fn(),
    getAccountTokenGroups: vi.fn().mockResolvedValue({ groups: ['default'] }),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

describe('Tokens route rendering', () => {
  it('renders /tokens directly and preserves token creation params', async () => {
    installAccountsSnapshotCompat(apiMock);
    let root!: WebTestRenderer;
    await act(async () => {
      root = create(
        <ToastProvider>
          <MemoryRouter initialEntries={['/tokens?create=1&accountId=23&model=gpt-4.1']}>
            <Tokens />
          </MemoryRouter>
        </ToastProvider>,
      );
    });

    const rendered = JSON.stringify(root?.toJSON());
    expect(rendered).toContain('账号令牌');
    expect(rendered).toContain('新增令牌');
    expect(rendered).not.toContain('/accounts?');
    root?.unmount();
  });
});
