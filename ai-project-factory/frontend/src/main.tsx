import "@ant-design/v5-patch-for-react-19";
import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider, App as AntApp } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";
import "./styles.css";
import "./theme.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#6265f5",
          colorInfo: "#6265f5",
          colorSuccess: "#20b68a",
          colorWarning: "#d99a32",
          colorError: "#e36380",
          borderRadius: 8,
          colorBorder: "#e2e7f3",
          controlHeight: 34,
          fontFamily:
            'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
          colorText: "#28334a",
          colorTextHeading: "#202b42",
          colorTextSecondary: "#4c5972",
          colorTextDescription: "#63718b",
          colorTextPlaceholder: "#63718b",
          colorTextDisabled: "#8a94a6",
          colorBgLayout: "#f8faff",
        },
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
