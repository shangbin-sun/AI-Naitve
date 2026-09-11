import { type ReactNode, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Space, Tag, Upload } from "antd";
import { api } from "../api";
import { ExperimentOutlined, EditOutlined } from "@ant-design/icons";

type Inputs = {
  description: string;
  input_text: string;
  attachments: { name: string; data: string }[];
  employee_version: number;
};
export default function EmployeeAbilityActions({
  base,
  disabled,
  running,
  onGenerate,
  onVerify,
  children,
}: {
  children?: ReactNode;
  base: string;
  disabled: boolean;
  running: boolean;
  onGenerate: () => Promise<boolean>;
  onVerify: (runId: string) => void;
}) {
  const [inputs, setInputs] = useState<Inputs>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const locked = useRef(false);
  async function generate() {
    if (locked.current || disabled || running) return;
    locked.current = true;
    setGenerating(true);
    try {
      await onGenerate();
    } finally {
      locked.current = false;
      setGenerating(false);
    }
  }
  const request = useRef({ signature: "", id: "" });
  async function openInputs() {
    if (locked.current || disabled || running) return;
    locked.current = true;
    setError("");
    setBusy(true);
    try {
      setInputs(await api<Inputs>(base + "/verification-inputs"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      locked.current = false;
    }
  }
  return (
    <>
      <span className="employee-ability-actions">
        <Button
          type="default"
          icon={<EditOutlined aria-hidden="true" />}
          disabled={disabled || busy}
          loading={running || generating}
          onClick={() => void generate()}
        >
          增强员工能力
        </Button>
        <Button
          type="default"
          icon={<ExperimentOutlined aria-hidden="true" />}
          disabled={disabled || running || generating || !!inputs}
          loading={busy && !inputs}
          aria-expanded={!!inputs}
          onClick={() => void openInputs()}
        >
          重新验证
        </Button>
        {children}
      </span>
      {error && !inputs && (
        <Alert
          type="error"
          message={error}
          closable
          onClose={() => setError("")}
        />
      )}
      <Modal
        title="重新验证员工"
        width={700}
        open={!!inputs}
        closable={!busy}
        maskClosable={!busy}
        keyboard={!busy}
        onCancel={() => {
          if (!busy) setInputs(undefined);
        }}
        footer={null}
      >
        {inputs && (
          <div className="tuning-skill-editor">
            <Tag>最新员工版本 v{inputs.employee_version}</Tag>
            <small>
              默认沿用原输入。使用新会话和空工作目录从头执行，旧批次保留。
            </small>
            <Input.TextArea
              aria-label="验证输入"
              value={inputs.description}
              autoSize={{ minRows: 4, maxRows: 10 }}
              onChange={(e) =>
                setInputs({ ...inputs, description: e.target.value })
              }
            />
            {inputs.input_text && (
              <Input.TextArea
                aria-label="原补充输入"
                value={inputs.input_text}
                onChange={(e) =>
                  setInputs({ ...inputs, input_text: e.target.value })
                }
              />
            )}
            <Space wrap>
              {inputs.attachments.map((f) => (
                <Tag
                  key={f.name}
                  closable
                  onClose={() =>
                    setInputs({
                      ...inputs,
                      attachments: inputs.attachments.filter(
                        (a) => a.name !== f.name,
                      ),
                    })
                  }
                >
                  {f.name}
                </Tag>
              ))}
            </Space>
            <Upload
              multiple
              showUploadList={false}
              beforeUpload={async (file) => {
                if (file.size > 10000000) {
                  setError("附件总大小不能超过 10 MB");
                  return false;
                }
                const data = await new Promise<string>((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () =>
                    resolve(String(reader.result).split(",")[1]);
                  reader.onerror = reject;
                  reader.readAsDataURL(file);
                });
                setInputs((value) =>
                  value
                    ? {
                        ...value,
                        attachments: [
                          ...value.attachments.filter(
                            (f) => f.name !== file.name,
                          ),
                          { name: file.name, data },
                        ],
                      }
                    : value,
                );
                return false;
              }}
            >
              <Button>添加图片或文件</Button>
            </Upload>
            {error && <Alert type="error" message={error} />}
            <Button
              type="primary"
              loading={busy}
              disabled={!inputs.description.trim() || disabled}
              onClick={async () => {
                setBusy(true);
                setError("");
                const body = {
                  description: inputs.description,
                  input_text: inputs.input_text,
                  attachments: inputs.attachments,
                };
                const signature = JSON.stringify(body);
                if (request.current.signature !== signature)
                  request.current = { signature, id: crypto.randomUUID() };
                try {
                  const result = await api<{ id: string }>(base + "/verify", {
                    method: "POST",
                    body: JSON.stringify({
                      ...body,
                      request_id: request.current.id,
                    }),
                  });
                  setInputs(undefined);
                  onVerify(result.id);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              开始验证
            </Button>
          </div>
        )}
      </Modal>
    </>
  );
}
