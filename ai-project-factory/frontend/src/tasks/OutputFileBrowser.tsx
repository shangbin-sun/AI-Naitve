import { Button } from "antd";
import { ArrowLeftOutlined, FileTextOutlined } from "@ant-design/icons";
import type { OutputStep } from "./buildOutputChain";

export default function OutputFileBrowser({
  name,
  steps,
  selected,
  onSelect,
  onBack,
}: {
  name: string;
  steps: OutputStep[];
  selected?: string;
  onSelect: (id: string) => void;
  onBack: () => void;
}) {
  const files = steps.flatMap((step) =>
    step.files.map((file, i) => ({ step, file, id: `${step.id}-${i}` })),
  );
  const current = files.find((f) => f.id === selected) ?? files[0];
  return (
    <section className="output-file-browser">
      <header>
        <Button
          aria-label="返回员工产出"
          icon={<ArrowLeftOutlined />}
          onClick={onBack}
        >
          返回员工产出
        </Button>
        <h3>{name} · 产出目录</h3>
        <span>{files.length} 个文件 · 历史快照只读</span>
      </header>
      <div className="output-file-layout">
        <nav aria-label="产出文件列表">
          {files.map(({ step, file, id }) => (
            <button
              key={id}
              type="button"
              aria-current={current?.id === id ? "page" : undefined}
              onClick={() => onSelect(id)}
              title={file.name}
            >
              <FileTextOutlined />
              <span>
                {file.name}
                <small>
                  {step.title} · {step.origin.slice(0, 8)}
                </small>
              </span>
            </button>
          ))}
        </nav>
        <article aria-label="文件内容">
          {current ? (
            <>
              <h4>{current.file.name}</h4>
              <p>
                {current.step.title} ·{" "}
                {current.step.reused ? "历史产出" : "本轮产出"} · 来源运行{" "}
                {current.step.origin}
              </p>
              <pre tabIndex={0}>
                {current.file.content ?? "此轮历史记录未保存文件正文。"}
              </pre>
            </>
          ) : (
            <p>暂无文件</p>
          )}
        </article>
      </div>
    </section>
  );
}
