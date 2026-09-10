import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App, ConfigProvider } from 'antd';
import TeamContextMenu from '../TeamContextMenu';
import { api } from '../api';
import type { Design } from '../types';

vi.mock('../api', () => ({ api: vi.fn() }));
const mocked = vi.mocked(api);
const team = { id: 'team-1', title: '原团队', version: 2 } as Design;
const renamed = vi.fn(), deleted = vi.fn(), restored = vi.fn();
function setup() {
  render(<ConfigProvider theme={{ token: { motion: false } }}><App><TeamContextMenu team={team} onRenamed={renamed} onDeleted={deleted} onRestored={restored}>
    <button>原团队</button>
  </TeamContextMenu></App></ConfigProvider>);
  fireEvent.contextMenu(screen.getByRole('button', { name: '原团队' }));
  return userEvent.setup();
}
beforeEach(() => { vi.clearAllMocks(); });
describe('团队右键菜单', () => {
  it('校验名称并保存重命名', async () => {
    const user = setup();
    await user.click(await screen.findByText('重命名', { exact: true }));
    const input = screen.getByRole('textbox', { name: '团队名称' });
    await user.clear(input);
    expect(screen.getByRole('button', { name: '保 存' })).toBeDisabled();
    await user.type(input, '新团队');
    mocked.mockResolvedValue({ ...team, title: '新团队', version: 3 });
    await user.click(screen.getByRole('button', { name: '保 存' }));
    await waitFor(() => expect(renamed).toHaveBeenCalledWith(expect.objectContaining({ title: '新团队' })));
    expect(mocked).toHaveBeenCalledWith('/workspaces/team-1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: '新团队', expected_version: 2 }) }));
  });
  it('取消删除不发请求，确认后支持撤销', async () => {
    const user = setup();
    await user.click(await screen.findByText('删除团队', { exact: true }));
    await user.click(screen.getByRole('button', { name: '取 消' }));
    expect(mocked).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.contextMenu(screen.getByRole('button', { name: '原团队' }));
    await user.click(await screen.findByText('删除团队', { exact: true }));
    mocked.mockResolvedValue({});
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除团队' }));
    await waitFor(() => expect(deleted).toHaveBeenCalledOnce());
    await user.click(await screen.findByRole('button', { name: '撤销' }));
    await waitFor(() => expect(restored).toHaveBeenCalledOnce());
    expect(mocked).toHaveBeenLastCalledWith('/workspaces/team-1/restore', { method: 'POST' });
  });
  it('保存失败保留输入并显示错误', async () => {
    const user = setup();
    await user.click(await screen.findByText('重命名', { exact: true }));
    mocked.mockRejectedValue(new Error('团队正在执行任务'));
    await user.click(screen.getByRole('button', { name: '保 存' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('团队正在执行任务');
    expect(renamed).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('原团队');
  });
});
