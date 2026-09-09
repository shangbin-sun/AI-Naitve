import "@ant-design/v5-patch-for-react-19";
import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider, App as AntApp } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#4869d8",
          borderRadius: 8,
          colorBorder: "#dce3ee",
          controlHeight: 34,
          fontFamily:
            'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
          colorText: "#344054",
          colorTextHeading: "#182230",
          colorTextSecondary: "#536176",
          colorTextDescription: "#65738a",
          colorTextPlaceholder: "#65738a",
          colorTextDisabled: "#8a94a6",
          colorBgLayout: "#f5f7fb",
        },
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
