import { useEffect, useState, type ReactNode } from "react";
import { Button, Drawer, Space } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";

// Nested employee/project pages share one background scroll lock.
let openPages = 0;
let previousOverflow = "";
function lockBackgroundScroll() {
  if (openPages++ === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  return () => {
    if (--openPages === 0) document.body.style.overflow = previousOverflow;
  };
}

/** A full-workspace detail page. Drawer supplies focus/keyboard handling only. */
export default function WorkspacePage({
  title,
  open,
  children,
  onClose,
  onCancel,
  onOk,
  okText,
  extra,
}: {
  title?: ReactNode;
  open: boolean;
  children: ReactNode;
  onClose?: () => void;
  onCancel?: () => void;
  onOk?: () => void | Promise<void>;
  okText?: string;
  extra?: ReactNode;
  destroyOnHidden?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) return lockBackgroundScroll();
  }, [open]);
  const back = onClose ?? onCancel;
  return (
    <Drawer
      title={title}
      open={open}
      onClose={back}
      width="100%"
      mask={false}
      push={false}
      rootClassName="workspace-page"
      rootStyle={{ inset: "var(--topbar-height) 0 0 var(--sidebar-width)" }}
      styles={{ wrapper: { boxShadow: "none" }, body: { padding: 0 } }}
      closeIcon={
        <span className="page-back">
          <ArrowLeftOutlined />
          返回
        </span>
      }
      extra={
        onOk ? (
          <Space>
            <Button onClick={back}>取消</Button>
            <Button
              type="primary"
              loading={saving}
              onClick={async () => {
                if (saving) return;
                setSaving(true);
                try {
                  await onOk();
                } finally {
                  setSaving(false);
                }
              }}
            >
              {okText ?? "保存"}
            </Button>
          </Space>
        ) : (
          extra
        )
      }
      destroyOnHidden
    >
      <div className="workspace-page-content">{children}</div>
    </Drawer>
  );
}
