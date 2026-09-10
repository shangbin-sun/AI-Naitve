import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DashboardPanel from '../DashboardPanel';
import { api } from '../api';
vi.mock('../api', () => ({ api: vi.fn() }));
const mock = vi.mocked(api);
beforeEach(() => { mock.mockReset(); });
it('生成入口通过对话配置，不写入员工编辑接口', async () => {
  mock.mockImplementation(async path => path.endsWith('agent-runs') ? [] : {dashboard: null,versions: []});
  const customize=vi.fn();
  render(<DashboardPanel projectId="p" onCustomize={customize} />);
  await screen.findByText('通过团队对话生成专属看板，页面和配置将独立保存');
  await userEvent.click(screen.getByRole('button',{name:'生成团队看板'}));
  expect(customize).toHaveBeenCalledWith(expect.stringContaining('save_dashboard'));
  expect(mock.mock.calls.every(([,options]) => !options?.method)).toBe(true);
});
it('预览锁定版本并使用不允许同源访问的沙箱', async () => {
  mock.mockImplementation(async path => path.endsWith('agent-runs') ? [] : path.includes('/preview?') ? {title:'成果',version:2,label:'配置预览 · 样例数据'} : {dashboard:{title:'成果',version:2},versions:[{title:'成果',version:2}]});
  render(<DashboardPanel projectId="p" onCustomize={vi.fn()} />);
  const frame=await screen.findByTitle('团队看板预览');
  expect(frame).toHaveAttribute('sandbox','allow-scripts');
  expect(frame).toHaveAttribute('src','/api/workspaces/p/dashboard/frame?version=2');
  expect(screen.getByText('配置预览 · 样例数据')).toBeVisible();
});
