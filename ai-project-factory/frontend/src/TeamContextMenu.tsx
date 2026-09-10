import { useState, type ReactElement } from 'react';
import { App, Button, Dropdown, Input, Modal } from 'antd';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { api } from './api';
import type { Design } from './types';

export default function TeamContextMenu({ team, children, onRenamed, onDeleted, onRestored }: {
  team: Design; children: ReactElement;
  onRenamed: (team: Design) => void; onDeleted: () => void; onRestored: () => void;
}) {
  const { modal, message } = App.useApp();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(team.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function rename() {
    if (saving || !title.trim()) return;
    setSaving(true); setError('');
    try {
      const result = await api<Design>(`/workspaces/${team.id}`, {
        method: 'PATCH', body: JSON.stringify({ title: title.trim(), expected_version: team.version }),
      });
      onRenamed(result); setRenaming(false);
      void message.success('团队已重命名');
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }
  function remove() {
    modal.confirm({
      title: `删除团队“${team.title}”？`,
      content: '团队及其员工将从列表移除，本地文件和历史记录会保留。删除后可通过提示中的“撤销”恢复。',
      okText: '删除团队', cancelText: '取消', okButtonProps: { danger: true },
      async onOk() {
        try {
          await api(`/workspaces/${team.id}`, { method: 'DELETE' });
        } catch (e) { void message.error((e as Error).message); throw e; }
        onDeleted();
        const key = `deleted-team-${team.id}`;
        let restoring = false;
        void message.success({ key, duration: 10, content: <span>团队已删除 <Button type="link" onClick={async () => {
          if (restoring) return;
          restoring = true;
          try {
            await api(`/workspaces/${team.id}/restore`, { method: 'POST' });
            onRestored(); message.destroy(key); void message.success('团队已恢复');
          } catch (e) { void message.error((e as Error).message); }
          finally { restoring = false; }
        }}>撤销</Button></span> });
      },
    });
  }
  return <>
    <Dropdown trigger={['contextMenu']} menu={{ items: [
      { key: 'rename', label: '重命名', icon: <EditOutlined /> },
      { type: 'divider' },
      { key: 'delete', label: '删除团队', icon: <DeleteOutlined />, danger: true },
    ], onClick: ({ key, domEvent }) => {
      domEvent.stopPropagation();
      if (key === 'rename') { setTitle(team.title); setError(''); setRenaming(true); }
      if (key === 'delete') remove();
    } }}>{children}</Dropdown>
    <Modal title="重命名团队" open={renaming} onCancel={() => { if (!saving) setRenaming(false); }}
      onOk={() => void rename()} okText="保存" cancelText="取消" confirmLoading={saving}
      okButtonProps={{ disabled: !title.trim() }}>
      <Input aria-label="团队名称" autoFocus maxLength={200} value={title} disabled={saving}
        onChange={e => setTitle(e.target.value)} onPressEnter={() => void rename()} />
      {error && <p role="alert" style={{ color: '#cf1322' }}>{error}</p>}
    </Modal>
  </>;
}
