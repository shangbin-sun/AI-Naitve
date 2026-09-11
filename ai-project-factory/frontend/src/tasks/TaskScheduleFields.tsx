import { Checkbox, Input, InputNumber, Select } from "antd";
import {
  ClockCircleOutlined,
  SyncOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
export type ScheduleForm = {
  timed: boolean;
  loop: boolean;
  start: string;
  repeat: boolean;
  minutes: number;
  condition: string;
  maxRuns: number;
};
export const emptySchedule: ScheduleForm = {
  timed: false,
  loop: false,
  start: "",
  repeat: false,
  minutes: 1,
  condition: "",
  maxRuns: 20,
};
export function schedulePayload(value: ScheduleForm) {
  if (!value.timed && !value.loop) return undefined;
  if (
    value.timed &&
    (!value.start ||
      !Number.isFinite(Date.parse(value.start)) ||
      Date.parse(value.start) <= Date.now())
  )
    throw new Error("请选择未来的执行时间");
  if (value.loop && !value.condition.trim())
    throw new Error("请填写循环停止条件");
  return {
    kind: value.loop ? "loop" : value.repeat ? "interval" : "once",
    start_at: value.timed ? new Date(value.start).toISOString() : null,
    interval_seconds: value.minutes * 60,
    stop_condition: value.condition,
    max_runs: value.maxRuns,
  };
}
export default function TaskScheduleFields({
  value,
  onChange,
}: {
  value: ScheduleForm;
  onChange: (v: ScheduleForm) => void;
}) {
  const update = (v: Partial<ScheduleForm>) => onChange({ ...value, ...v });
  const repeating = value.loop || (value.timed && value.repeat);
  return (
    <section className="execution-settings">
      <div className="task-section-heading">
        <span>02</span>
        <div>
          <h3>执行安排</h3>
          <p>立即开始，或为任务设定时间与结束条件。</p>
        </div>
      </div>
      <div className="execution-options">
        <div className={`execution-option ${value.timed ? "is-selected" : ""}`}>
          <ClockCircleOutlined className="execution-option-icon" />
          <Checkbox
            checked={value.timed}
            onChange={(e) => update({ timed: e.target.checked })}
          >
            定时执行
          </Checkbox>
          <p>在指定时间开始，也可按间隔重复。</p>
        </div>
        <div className={`execution-option ${value.loop ? "is-selected" : ""}`}>
          <SyncOutlined className="execution-option-icon" />
          <Checkbox
            checked={value.loop}
            onChange={(e) => update({ loop: e.target.checked })}
          >
            按条件循环执行
          </Checkbox>
          <p>每轮检查结果，达到目标后自动结束。</p>
        </div>
      </div>
      {(value.timed || value.loop) && (
        <div className="execution-configuration">
          {value.timed && (
            <div className="execution-field-grid">
              <label>
                首次执行时间
                <Input
                  aria-label="首次执行时间"
                  type="datetime-local"
                  value={value.start}
                  onChange={(e) => update({ start: e.target.value })}
                />
              </label>
              {!value.loop && (
                <label>
                  执行频率
                  <Select
                    aria-label="定时方式"
                    value={value.repeat ? "interval" : "once"}
                    onChange={(repeat) =>
                      update({ repeat: repeat === "interval" })
                    }
                    options={[
                      { value: "once", label: "仅执行一次" },
                      { value: "interval", label: "按间隔重复执行" },
                    ]}
                  />
                </label>
              )}
            </div>
          )}
          {value.loop && (
            <label>
              停止条件
              <Input.TextArea
                aria-label="循环停止条件"
                autoSize={{ minRows: 2, maxRows: 5 }}
                placeholder="例如：所有验收项均通过，且没有未解决的问题"
                value={value.condition}
                onChange={(e) => update({ condition: e.target.value })}
              />
            </label>
          )}
          {repeating && (
            <div className="execution-field-grid">
              <label>
                每轮完成后间隔（分钟）
                <InputNumber
                  aria-label="执行间隔"
                  min={1}
                  max={525600}
                  value={value.minutes}
                  onChange={(v) => update({ minutes: v ?? 1 })}
                />
              </label>
              <label>
                最多执行次数
                <InputNumber
                  aria-label="最多执行次数"
                  min={1}
                  precision={0}
                  max={1000}
                  value={value.maxRuns}
                  onChange={(v) => update({ maxRuns: v ?? 20 })}
                />
              </label>
            </div>
          )}
          <div className="execution-summary">
            <ClockCircleOutlined />
            <span>
              {value.timed ? "按指定时间开始" : "创建后立即开始"}
              {repeating
                ? `，每轮结束后等待 ${value.minutes} 分钟，最多执行 ${value.maxRuns} 次。`
                : "，完成一轮后结束。"}
              {value.loop && " 满足停止条件时提前结束。"}
            </span>
          </div>
          <small className="execution-help">
            {value.timed && "时间使用本机时区；"}本地服务需保持运行。
            {repeating
              ? "异常或需要人工处理时暂停；无法判断停止条件时也会暂停。"
              : "离线错过的执行将在服务启动后补一次。"}
          </small>
        </div>
      )}
      {!value.timed && !value.loop && (
        <div className="execution-summary">
          <ThunderboltOutlined />
          <span>默认立即执行一次。也可以同时启用定时与条件循环。</span>
        </div>
      )}
    </section>
  );
}
